/**
 * One-time setup against an admin connection: creates the `slopwatch` role,
 * the `slopwatch` and `slopwatch_test` databases, and prints the app DSN.
 *
 * Usage: ADMIN_DATABASE_URL=postgres://postgres:<pw>@localhost:5432/postgres \
 *          bun apps/server/src/setup-db.ts
 */
import { Client } from "pg";

const adminUrl = process.env.ADMIN_DATABASE_URL;
if (!adminUrl) {
  console.error(
    "ADMIN_DATABASE_URL is required (superuser DSN, e.g. postgres://postgres:pw@localhost:5432/postgres)",
  );
  process.exit(1);
}

const appPassword =
  process.env.SLOPWATCH_DB_PASSWORD ?? `sw_${crypto.randomUUID().slice(0, 18)}`;

const admin = new Client({ connectionString: adminUrl });
await admin.connect();

const roleExists = async () =>
  (await admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'slopwatch'"))
    .rowCount === 1;

if (!(await roleExists())) {
  await admin.query(`CREATE ROLE slopwatch LOGIN PASSWORD '${appPassword}'`);
  console.log("created role slopwatch");
} else {
  console.log("role slopwatch already exists — leaving password unchanged");
}

for (const db of ["slopwatch", "slopwatch_test"]) {
  const exists = await admin.query(
    "SELECT 1 FROM pg_database WHERE datname = $1",
    [db],
  );
  if (exists.rowCount === 0) {
    await admin.query(`CREATE DATABASE ${db} OWNER slopwatch`);
    console.log(`created database ${db}`);
  } else {
    console.log(`database ${db} already exists`);
  }
}

await admin.end();
console.log(
  `\napp DSN: postgres://slopwatch:${appPassword}@localhost:5432/slopwatch`,
);
console.log(
  `test DSN: postgres://slopwatch:${appPassword}@localhost:5432/slopwatch_test`,
);
