import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'sqlite', schema: './src/lib/db/provider/sqlite/schema.ts',
  out: './drizzle', dbCredentials: { url: process.env.DB_FILE ?? 'data/app.db' },
});
