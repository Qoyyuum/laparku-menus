create table "passkey" ("id" text not null primary key, "name" text, "publicKey" text not null, "userId" text not null references "user" ("id") on delete cascade, "credentialID" text not null, "counter" integer not null, "deviceType" text not null, "backedUp" integer not null, "transports" text, "createdAt" date, "aaguid" text);--> statement-breakpoint
create index "passkey_userId_idx" on "passkey" ("userId");--> statement-breakpoint
create index "passkey_credentialID_idx" on "passkey" ("credentialID");--> statement-breakpoint
ALTER TABLE "user" ADD `theme` text DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD `preferred_social` text;--> statement-breakpoint
ALTER TABLE "user" ADD `gravatar_accounts` text;--> statement-breakpoint
ALTER TABLE "user" ADD `gravatar_fetched_at` date;
