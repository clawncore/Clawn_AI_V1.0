import { PrismaClient } from '@prisma/client';

/**
 * BotStateManager — Singleton that controls whether the Simby AI bot is active.
 * State is persisted to Supabase (PostgreSQL) via raw SQL — no schema migration required.
 * The table is auto-created on first boot.
 *
 * Admin number: +918790813536 (only this number can issue commands)
 * Commands: "bot on", "bot off", "bot schedule till morning", "bot status"
 */

// Zimbabwe is UTC+2
const ZIMBABWE_OFFSET_HOURS = 2;

// "Morning" = 8:00 AM Zimbabwe time
const MORNING_HOUR_ZW = 8;

// Singleton row ID
const SINGLETON_ID = 'simby_bot_state';

interface BotState {
  botEnabled: boolean;
  scheduledOffAt: Date | null;
  scheduledOnAt: Date | null;
}

class BotStateManagerClass {
  private prisma: PrismaClient;

  // In-memory cache — updated on every read/write to avoid hammering DB
  private cache: BotState = {
    botEnabled: true,
    scheduledOffAt: null,
    scheduledOnAt: null,
  };

  // Admin WhatsApp JID
  public readonly ADMIN_JID = '918790813536@s.whatsapp.net';

  constructor() {
    this.prisma = new PrismaClient();
    this.init();
  }

  // ─── Boot: Ensure Table Exists & Load State ──────────────────────────────────

  private async init(): Promise<void> {
    try {
      // Auto-create table if it doesn't exist (idempotent)
      await this.prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "BotState" (
          "id"             TEXT PRIMARY KEY,
          "botEnabled"     BOOLEAN NOT NULL DEFAULT true,
          "scheduledOffAt" TIMESTAMPTZ,
          "scheduledOnAt"  TIMESTAMPTZ,
          "updatedAt"      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      // Ensure the singleton row exists
      await this.prisma.$executeRawUnsafe(`
        INSERT INTO "BotState" ("id", "botEnabled", "scheduledOffAt", "scheduledOnAt", "updatedAt")
        VALUES ('${SINGLETON_ID}', true, NULL, NULL, NOW())
        ON CONFLICT ("id") DO NOTHING
      `);

      // Load current state into cache
      await this.reload();

      // Start schedule ticker — checks every 60 seconds
      setInterval(() => this.tickSchedule(), 60_000);

      console.log('[BotStateManager] Initialized. Bot state loaded from Supabase.');
    } catch (err: any) {
      console.error('[BotStateManager] Init failed:', err.message);
    }
  }

  // ─── DB Helpers ──────────────────────────────────────────────────────────────

  private async reload(): Promise<void> {
    try {
      const rows = await this.prisma.$queryRawUnsafe<BotState[]>(
        `SELECT "botEnabled", "scheduledOffAt", "scheduledOnAt" FROM "BotState" WHERE "id" = '${SINGLETON_ID}' LIMIT 1`,
      );
      if (rows && rows.length > 0) {
        this.cache = {
          botEnabled: rows[0].botEnabled,
          scheduledOffAt: rows[0].scheduledOffAt ? new Date(rows[0].scheduledOffAt) : null,
          scheduledOnAt: rows[0].scheduledOnAt ? new Date(rows[0].scheduledOnAt) : null,
        };
      }
    } catch (err: any) {
      console.error('[BotStateManager] reload failed:', err.message);
    }
  }

  private async persist(state: Partial<BotState>): Promise<void> {
    const enabled = state.botEnabled !== undefined ? state.botEnabled : this.cache.botEnabled;
    const offAt = state.scheduledOffAt !== undefined ? state.scheduledOffAt : this.cache.scheduledOffAt;
    const onAt = state.scheduledOnAt !== undefined ? state.scheduledOnAt : this.cache.scheduledOnAt;

    const offAtSql = offAt ? `'${offAt.toISOString()}'` : 'NULL';
    const onAtSql = onAt ? `'${onAt.toISOString()}'` : 'NULL';

    try {
      await this.prisma.$executeRawUnsafe(`
        UPDATE "BotState"
        SET "botEnabled" = ${enabled},
            "scheduledOffAt" = ${offAtSql},
            "scheduledOnAt" = ${onAtSql},
            "updatedAt" = NOW()
        WHERE "id" = '${SINGLETON_ID}'
      `);
      // Update cache immediately
      this.cache = { botEnabled: enabled, scheduledOffAt: offAt, scheduledOnAt: onAt };
    } catch (err: any) {
      console.error('[BotStateManager] persist failed:', err.message);
    }
  }

  // ─── Schedule Ticker ─────────────────────────────────────────────────────────

  private async tickSchedule(): Promise<void> {
    await this.reload(); // Always read fresh state from DB

    const now = Date.now();

    // Auto-turn OFF at scheduled time
    if (this.cache.scheduledOffAt && now >= this.cache.scheduledOffAt.getTime()) {
      await this.persist({ botEnabled: false, scheduledOffAt: null });
      console.log('[BotStateManager] Scheduled OFF triggered. Bot is now disabled.');
    }

    // Auto-turn ON at scheduled time
    if (this.cache.scheduledOnAt && now >= this.cache.scheduledOnAt.getTime()) {
      await this.persist({ botEnabled: true, scheduledOnAt: null });
      console.log('[BotStateManager] Scheduled ON triggered. Bot is now active.');
    }
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  /** Returns true if the bot should respond right now (uses in-memory cache for speed) */
  isActive(): boolean {
    return this.cache.botEnabled;
  }

  /** Enable bot immediately */
  async enable(): Promise<string> {
    await this.persist({ botEnabled: true, scheduledOffAt: null, scheduledOnAt: null });
    return '✅ Bot is now ON. Simby AI is active and replying to everyone.';
  }

  /** Disable bot immediately */
  async disable(): Promise<string> {
    await this.persist({ botEnabled: false, scheduledOffAt: null, scheduledOnAt: null });
    return '🔴 Bot is now OFF. Simby AI has paused all replies.';
  }

  /**
   * "bot schedule till morning"
   * Enables the bot NOW and schedules it to turn OFF at next 8:00 AM Zimbabwe time (UTC+2).
   */
  async scheduleTillMorning(): Promise<string> {
    const now = new Date();

    // Compute current Zimbabwe time
    const zwNow = new Date(now.getTime() + ZIMBABWE_OFFSET_HOURS * 3_600_000);
    const zwMorning = new Date(zwNow);
    zwMorning.setHours(MORNING_HOUR_ZW, 0, 0, 0);

    // If it's already past 8AM Zimbabwe today, aim for tomorrow
    if (zwNow >= zwMorning) {
      zwMorning.setDate(zwMorning.getDate() + 1);
    }

    // Convert back to UTC
    const offAtUtc = new Date(zwMorning.getTime() - ZIMBABWE_OFFSET_HOURS * 3_600_000);

    await this.persist({ botEnabled: true, scheduledOffAt: offAtUtc, scheduledOnAt: null });

    const readableDate = zwMorning.toLocaleDateString('en-ZW', { weekday: 'long', month: 'short', day: 'numeric' });
    return `🌙 Bot is ON now and will automatically turn OFF at ${MORNING_HOUR_ZW}:00 AM Zimbabwe time (${readableDate}).`;
  }

  /** Returns a formatted status string */
  async getStatusMessage(): Promise<string> {
    await this.reload();
    const s = this.cache;
    const onOff = s.botEnabled ? 'ON ✅' : 'OFF 🔴';

    let schedLine = '• No schedule set';
    if (s.scheduledOffAt) {
      // Display in Zimbabwe time
      const zwOff = new Date(s.scheduledOffAt.getTime() + ZIMBABWE_OFFSET_HOURS * 3_600_000);
      schedLine = `• Auto-OFF at: ${zwOff.toLocaleString('en-ZW')} (ZW time)`;
    } else if (s.scheduledOnAt) {
      const zwOn = new Date(s.scheduledOnAt.getTime() + ZIMBABWE_OFFSET_HOURS * 3_600_000);
      schedLine = `• Auto-ON at: ${zwOn.toLocaleString('en-ZW')} (ZW time)`;
    }

    return `📊 Simby Bot Status\n• State: ${onOff}\n${schedLine}`;
  }

  /** Check if a JID is the admin */
  isAdmin(remoteJid: string): boolean {
    return remoteJid === this.ADMIN_JID;
  }
}

// Export as singleton
export const BotStateManager = new BotStateManagerClass();
