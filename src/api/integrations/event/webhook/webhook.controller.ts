import { EventDto } from '@api/integrations/event/event.dto';
import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { wa } from '@api/types/wa.types';
import { configService, Log, Webhook } from '@config/env.config';
import { Logger } from '@config/logger.config';
// import { BadRequestException } from '@exceptions';
import axios, { AxiosInstance } from 'axios';
import * as jwt from 'jsonwebtoken';

import { EmitData, EventController, EventControllerInterface } from '../event.controller';
import { BotStateManager } from './bot-state.manager';

export class WebhookController extends EventController implements EventControllerInterface {
  private readonly logger = new Logger('WebhookController');

  // Tracks the last manual human message timestamp per remoteJid
  private static lastHumanMessageTime = new Map<string, number>();

  // Tracks the message IDs sent by the bot to distinguish them from human messages
  public static botSentMessageIds = new Set<string>();

  constructor(prismaRepository: PrismaRepository, waMonitor: WAMonitoringService) {
    super(prismaRepository, waMonitor, true, 'webhook');
  }

  override async set(instanceName: string, data: EventDto): Promise<wa.LocalWebHook> {
    // if (!/^(https?:\/\/)/.test(data.webhook.url)) {
    //   throw new BadRequestException('Invalid "url" property');
    // }

    if (!data.webhook?.enabled) {
      data.webhook.events = [];
    } else {
      if (0 === data.webhook.events.length) {
        data.webhook.events = EventController.events;
      }
    }

    return this.prisma.webhook.upsert({
      where: {
        instanceId: this.monitor.waInstances[instanceName].instanceId,
      },
      update: {
        enabled: data.webhook?.enabled,
        events: data.webhook?.events,
        url: data.webhook?.url,
        headers: data.webhook?.headers,
        webhookBase64: data.webhook.base64,
        webhookByEvents: data.webhook.byEvents,
      },
      create: {
        enabled: data.webhook?.enabled,
        events: data.webhook?.events,
        instanceId: this.monitor.waInstances[instanceName].instanceId,
        url: data.webhook?.url,
        headers: data.webhook?.headers,
        webhookBase64: data.webhook.base64,
        webhookByEvents: data.webhook.byEvents,
      },
    });
  }

  public async emit({
    instanceName,
    origin,
    event,
    data,
    serverUrl,
    dateTime,
    sender,
    apiKey,
    local,
    integration,
    extra,
  }: EmitData): Promise<void> {
    if (integration && !integration.includes('webhook')) {
      return;
    }

    // ── ADMIN COMMAND INTERCEPTION ─────────────────────────────────────────────
    // Only runs for messages.upsert events from the admin number
    if (event === 'messages.upsert') {
      const senderJid = data?.key?.remoteJid;
      const fromMe = data?.key?.fromMe;
      const msgText: string =
        data?.message?.conversation ||
        data?.message?.extendedTextMessage?.text ||
        '';
      const cmd = msgText.trim().toLowerCase();

      if (fromMe === true && BotStateManager.isAdmin(senderJid)) {
        // This is YOU sending a command from your admin number
        let reply: string | null = null;

        if (cmd === 'bot on') {
          reply = await BotStateManager.enable();
        } else if (cmd === 'bot off') {
          reply = await BotStateManager.disable();
        } else if (cmd === 'bot schedule till morning' || cmd === 'bot schedule') {
          reply = await BotStateManager.scheduleTillMorning();
        } else if (cmd === 'bot status') {
          reply = await BotStateManager.getStatusMessage();
        }

        if (reply !== null) {
          this.logger.log(`Admin command from ${senderJid}: "${cmd}" → ${reply}`);
          const instanceObj = this.monitor.waInstances[instanceName];
          if (instanceObj) {
            try {
              await instanceObj.textMessage({
                number: BotStateManager.ADMIN_JID,
                text: reply,
              });
            } catch (err) {
              this.logger.error(`Failed to send admin confirmation: ${err.message}`);
            }
          }
          return; // Never forward admin commands to n8n
        }
      }
    }

    // ── GLOBAL BOT ENABLED CHECK ──────────────────────────────────────────────
    // If bot is disabled (via command or schedule), discard ALL message webhooks silently
    if (event === 'messages.upsert' || event === 'send.message') {
      if (!BotStateManager.isActive()) {
        this.logger.log(`Bot is currently OFF. Discarding webhook event: ${event}`);
        return;
      }
    }

    // 1. Group check: Ignore all group events for messages
    if (event === 'messages.upsert' || event === 'send.message') {
      const remoteJid = data?.key?.remoteJid;
      if (remoteJid && remoteJid.includes('@g.us')) {
        this.logger.log(`Ignoring group event ${event} for JID: ${remoteJid}`);
        return;
      }
    }

    // 2. Track bot-sent message IDs to prevent self-replies
    if (event === 'send.message') {
      const messageId = data?.key?.id;
      if (messageId) {
        WebhookController.botSentMessageIds.add(messageId);
        this.logger.verbose(`Registered bot-sent message ID: ${messageId}`);
      }
    }

    // 3. Process messages.upsert for Manual Override & Self-Reply checks
    if (event === 'messages.upsert') {
      const messageId = data?.key?.id;
      const remoteJid = data?.key?.remoteJid;
      const fromMe = data?.key?.fromMe;

      // Clean up and check if the message was sent by the bot
      if (messageId && WebhookController.botSentMessageIds.has(messageId)) {
        WebhookController.botSentMessageIds.delete(messageId);
        this.logger.verbose(`Prevented self-reply on message ID: ${messageId}`);
        return;
      }

      if (remoteJid) {
        if (fromMe === true) {
          // Manual human text from Simby's phone! Start 10-minute pause/override
          WebhookController.lastHumanMessageTime.set(remoteJid, Date.now());
          this.logger.log(`Manual human text detected for ${remoteJid}. Bot paused for 10 minutes.`);
          return; // Ignore Simby's own text from trigger webhooks to n8n
        } else {
          // Message from the other contact! Check active manual override timer
          const lastHumanTime = WebhookController.lastHumanMessageTime.get(remoteJid);
          const tenMinutes = 10 * 60 * 1000;

          if (lastHumanTime) {
            const timeDiff = Date.now() - lastHumanTime;
            if (timeDiff < tenMinutes) {
              const minutesLeft = ((tenMinutes - timeDiff) / (60 * 1000)).toFixed(1);
              this.logger.log(`Bot is paused for ${remoteJid} due to active manual override (${minutesLeft}m remaining). Discarding webhook.`);
              return;
            } else {
              // Override expired! Prepend the transition message
              this.logger.log(`Manual override expired for ${remoteJid}. Sending transition message.`);
              const instanceObj = this.monitor.waInstances[instanceName];
              if (instanceObj) {
                try {
                  await instanceObj.textMessage({
                    number: remoteJid,
                    text: 'sorry Simby is not there but I am here to talk with you',
                  });
                } catch (err) {
                  this.logger.error(`Failed to send transition message: ${err.message}`);
                }
              }
              WebhookController.lastHumanMessageTime.delete(remoteJid);
            }
          }
        }
      }
    }

    const instance = (await this.get(instanceName)) as wa.LocalWebHook;

    const webhookConfig = configService.get<Webhook>('WEBHOOK');
    const webhookLocal = instance?.events;
    const webhookHeaders = { ...((instance?.headers as Record<string, string>) || {}) };

    if (webhookHeaders && 'jwt_key' in webhookHeaders) {
      const jwtKey = webhookHeaders['jwt_key'];
      const jwtToken = this.generateJwtToken(jwtKey);
      webhookHeaders['Authorization'] = `Bearer ${jwtToken}`;

      delete webhookHeaders['jwt_key'];
    }

    const we = event.replace(/[.-]/gm, '_').toUpperCase();
    const transformedWe = we.replace(/_/gm, '-').toLowerCase();
    const enabledLog = configService.get<Log>('LOG').LEVEL.includes('WEBHOOKS');
    const regex = /^(https?:\/\/)/;

    const webhookData = {
      ...(extra ?? {}),
      event,
      instance: instanceName,
      data,
      destination: instance?.url || `${webhookConfig.GLOBAL.URL}/${transformedWe}`,
      date_time: dateTime,
      sender,
      server_url: serverUrl,
      apikey: apiKey,
    };

    // ── LOCAL INSTANCE WEBHOOK ────────────────────────────────────────────────
    // Skip if global webhook is enabled — global already handles delivery to n8n.
    // Sending both causes n8n to receive the message twice → two AI replies.
    if (local && instance?.enabled && !webhookConfig.GLOBAL?.ENABLED) {
      if (Array.isArray(webhookLocal) && webhookLocal.includes(we)) {
        let baseURL: string;

        if (instance?.webhookByEvents) {
          baseURL = `${instance?.url}/${transformedWe}`;
        } else {
          baseURL = instance?.url;
        }

        if (enabledLog) {
          const logData = {
            local: `${origin}.sendData-Webhook`,
            url: baseURL,
            ...webhookData,
          };

          this.logger.log(logData);
        }

        try {
          if (instance?.enabled && regex.test(instance.url)) {
            const httpService = axios.create({
              baseURL,
              headers: webhookHeaders as Record<string, string> | undefined,
              timeout: webhookConfig.REQUEST?.TIMEOUT_MS ?? 30000,
            });

            await this.retryWebhookRequest(httpService, webhookData, `${origin}.sendData-Webhook`, baseURL, serverUrl);
          }
        } catch (error) {
          this.logger.error({
            local: `${origin}.sendData-Webhook`,
            message: `Todas as tentativas falharam: ${error?.message}`,
            hostName: error?.hostname,
            syscall: error?.syscall,
            code: error?.code,
            error: error?.errno,
            stack: error?.stack,
            name: error?.name,
            url: baseURL,
            server_url: serverUrl,
          });
        }
      }
    } else if (local && instance?.enabled && webhookConfig.GLOBAL?.ENABLED) {
      this.logger.verbose(`Skipping local instance webhook — global webhook is active. Preventing double-send to n8n.`);
    }

    if (webhookConfig.GLOBAL?.ENABLED) {
      if (webhookConfig.EVENTS[we]) {
        let globalURL = webhookConfig.GLOBAL.URL;

        if (webhookConfig.GLOBAL.WEBHOOK_BY_EVENTS) {
          globalURL = `${globalURL}/${transformedWe}`;
        }

        if (enabledLog) {
          const logData = {
            local: `${origin}.sendData-Webhook-Global`,
            url: globalURL,
            ...webhookData,
          };

          this.logger.log(logData);
        }

        try {
          if (regex.test(globalURL)) {
            const httpService = axios.create({
              baseURL: globalURL,
              timeout: webhookConfig.REQUEST?.TIMEOUT_MS ?? 30000,
            });

            await this.retryWebhookRequest(
              httpService,
              webhookData,
              `${origin}.sendData-Webhook-Global`,
              globalURL,
              serverUrl,
            );
          }
        } catch (error) {
          this.logger.error({
            local: `${origin}.sendData-Webhook-Global`,
            message: `Todas as tentativas falharam: ${error?.message}`,
            hostName: error?.hostname,
            syscall: error?.syscall,
            code: error?.code,
            error: error?.errno,
            stack: error?.stack,
            name: error?.name,
            url: globalURL,
            server_url: serverUrl,
          });
        }
      }
    }
  }

  private async retryWebhookRequest(
    httpService: AxiosInstance,
    webhookData: any,
    origin: string,
    baseURL: string,
    serverUrl: string,
    maxRetries?: number,
    delaySeconds?: number,
  ): Promise<void> {
    const webhookConfig = configService.get<Webhook>('WEBHOOK');
    const maxRetryAttempts = maxRetries ?? webhookConfig.RETRY?.MAX_ATTEMPTS ?? 10;
    const initialDelay = delaySeconds ?? webhookConfig.RETRY?.INITIAL_DELAY_SECONDS ?? 5;
    const useExponentialBackoff = webhookConfig.RETRY?.USE_EXPONENTIAL_BACKOFF ?? true;
    const maxDelay = webhookConfig.RETRY?.MAX_DELAY_SECONDS ?? 300;
    const jitterFactor = webhookConfig.RETRY?.JITTER_FACTOR ?? 0.2;
    const nonRetryableStatusCodes = webhookConfig.RETRY?.NON_RETRYABLE_STATUS_CODES ?? [400, 401, 403, 404, 422];

    let attempts = 0;

    while (attempts < maxRetryAttempts) {
      try {
        await httpService.post('', webhookData);
        if (attempts > 0) {
          this.logger.log({
            local: `${origin}`,
            message: `Sucesso no envio após ${attempts + 1} tentativas`,
            url: baseURL,
          });
        }
        return;
      } catch (error) {
        attempts++;

        const isTimeout = error.code === 'ECONNABORTED';

        if (error?.response?.status && nonRetryableStatusCodes.includes(error.response.status)) {
          this.logger.error({
            local: `${origin}`,
            message: `Erro não recuperável (${error.response.status}): ${error?.message}. Cancelando retentativas.`,
            statusCode: error?.response?.status,
            url: baseURL,
            server_url: serverUrl,
          });
          throw error;
        }

        this.logger.error({
          local: `${origin}`,
          message: `Tentativa ${attempts}/${maxRetryAttempts} falhou: ${isTimeout ? 'Timeout da requisição' : error?.message}`,
          hostName: error?.hostname,
          syscall: error?.syscall,
          code: error?.code,
          isTimeout,
          statusCode: error?.response?.status,
          error: error?.errno,
          stack: error?.stack,
          name: error?.name,
          url: baseURL,
          server_url: serverUrl,
        });

        if (attempts === maxRetryAttempts) {
          throw error;
        }

        let nextDelay = initialDelay;
        if (useExponentialBackoff) {
          nextDelay = Math.min(initialDelay * Math.pow(2, attempts - 1), maxDelay);

          const jitter = nextDelay * jitterFactor * (Math.random() * 2 - 1);
          nextDelay = Math.max(initialDelay, nextDelay + jitter);
        }

        this.logger.log({
          local: `${origin}`,
          message: `Aguardando ${nextDelay.toFixed(1)} segundos antes da próxima tentativa`,
          url: baseURL,
        });

        await new Promise((resolve) => setTimeout(resolve, nextDelay * 1000));
      }
    }
  }

  private generateJwtToken(authToken: string): string {
    try {
      const payload = {
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 600, // 10 min expiration
        app: 'evolution',
        action: 'webhook',
      };

      const token = jwt.sign(payload, authToken, { algorithm: 'HS256' });
      return token;
    } catch (error) {
      this.logger.error({
        local: 'WebhookController.generateJwtToken',
        message: `JWT generation failed: ${error?.message}`,
      });
      throw error;
    }
  }
}
