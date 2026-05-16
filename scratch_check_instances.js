const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const instances = await prisma.instance.findMany();
  console.log('Instances in DB:', JSON.stringify(instances, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
