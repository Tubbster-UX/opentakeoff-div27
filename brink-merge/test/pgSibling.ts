// A throwaway database beside BRINK_TEST_DATABASE_URL, created per suite and
// dropped after it. db.test.ts needs that database EMPTY (it asserts the full
// migration list on first run), so any other suite that runs on real Postgres
// takes a sibling instead of sharing it — vitest runs test files in parallel.
import { openPostgres, type Db } from "../src/db/db.js";

export async function siblingPostgres(tag: string): Promise<Db> {
  const admin = await openPostgres(process.env.BRINK_TEST_DATABASE_URL!);
  const name = `brink_${tag}_test_${process.pid}_${Date.now()}`;
  await admin.exec(`create database ${name}`);
  const url = new URL(process.env.BRINK_TEST_DATABASE_URL!);
  url.pathname = `/${name}`;
  const db = await openPostgres(url.toString());
  return {
    ...db,
    close: async () => {
      await db.close();
      await admin.exec(`drop database if exists ${name}`);
      await admin.close();
    },
  };
}
