-- better-auth core + plugin tables (admin role fields, magic-link uses
-- `verification`, apiKey uses `apikey`). Generated via
-- `bun scripts/gen-auth-schema.ts` (@better-auth/kysely-adapter migration
-- plan compiled against a local sqlite — the CLI cannot reach the D1
-- binding), then folded into drizzle migration format by hand.
-- Sqlite stores better-auth `date` fields as ISO strings and `boolean` as
-- 0/1 integers; `date`/`integer` column types below are what the adapter
-- writes and reads back itself.
create table "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null, "role" text, "banned" integer, "banReason" text, "banExpires" date);--> statement-breakpoint
create table "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade, "impersonatedBy" text);--> statement-breakpoint
create table "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);--> statement-breakpoint
create table "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);--> statement-breakpoint
create table "apikey" ("id" text not null primary key, "configId" text not null, "name" text, "start" text, "referenceId" text not null, "prefix" text, "key" text not null, "refillInterval" integer, "refillAmount" integer, "lastRefillAt" date, "enabled" integer, "rateLimitEnabled" integer, "rateLimitTimeWindow" integer, "rateLimitMax" integer, "requestCount" integer, "remaining" integer, "lastRequest" date, "expiresAt" date, "createdAt" date not null, "updatedAt" date not null, "permissions" text, "metadata" text);--> statement-breakpoint
create index "session_userId_idx" on "session" ("userId");--> statement-breakpoint
create index "account_userId_idx" on "account" ("userId");--> statement-breakpoint
create index "verification_identifier_idx" on "verification" ("identifier");--> statement-breakpoint
create index "apikey_configId_idx" on "apikey" ("configId");--> statement-breakpoint
create index "apikey_referenceId_idx" on "apikey" ("referenceId");--> statement-breakpoint
create index "apikey_key_idx" on "apikey" ("key");
