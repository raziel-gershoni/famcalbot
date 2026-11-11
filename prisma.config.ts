// Prisma CLI configuration (Prisma 7: the connection string and the seed moved here from schema.prisma and package.json).
// The CLI loads no .env file: it reads the process environment. Migrations run on the unpooled DIRECT_URL, read from
// process.env and not with Prisma's env(), so `prisma generate` works without it (env() throws when the variable is unset);
// a command that needs the database (migrate deploy) then refuses with "The datasource.url property is required".
// The app's own queries use the pooled DATABASE_URL through the pg adapter (src/utils/prisma-client.ts).
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: process.env.DIRECT_URL,
  },
});
