import postgres from "postgres";

export const sql = postgres(process.env.DATABASE_URL ?? "", {
  max: 5,
  idle_timeout: 20,
});
