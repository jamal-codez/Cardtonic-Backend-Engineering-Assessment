import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/common/db/schema/*.ts',
  out: './drizzle',
});
