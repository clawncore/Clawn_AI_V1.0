const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('🧹 Starting Database Purge...');

  // Delete message, chat, contact, session history
  const deletedMessages = await prisma.message.deleteMany();
  console.log(`Deleted messages: ${deletedMessages.count}`);

  const deletedMessageUpdates = await prisma.messageUpdate.deleteMany();
  console.log(`Deleted message updates: ${deletedMessageUpdates.count}`);

  const deletedChats = await prisma.chat.deleteMany();
  console.log(`Deleted chats: ${deletedChats.count}`);

  const deletedContacts = await prisma.contact.deleteMany();
  console.log(`Deleted contacts: ${deletedContacts.count}`);

  const deletedSessions = await prisma.session.deleteMany();
  console.log(`Deleted Baileys sessions: ${deletedSessions.count}`);

  const deletedIntegrationSessions = await prisma.integrationSession.deleteMany();
  console.log(`Deleted AI Integration sessions: ${deletedIntegrationSessions.count}`);

  const deletedWebhooks = await prisma.webhook.deleteMany();
  console.log(`Deleted webhooks: ${deletedWebhooks.count}`);

  // Delete the instances themselves
  const deletedInstances = await prisma.instance.deleteMany();
  console.log(`Deleted Instances: ${deletedInstances.count}`);

  console.log('✨ Database Purge Complete! Your database is now a clean slate.');
}

main()
  .catch((err) => {
    console.error('❌ Error during purge:', err);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
