CREATE TABLE "daily_rollups" (
	"day" date NOT NULL,
	"provider" text NOT NULL,
	"requests" integer NOT NULL,
	"errors" integer NOT NULL,
	"p50_ms" integer,
	"p95_ms" integer,
	CONSTRAINT "daily_rollups_day_provider_pk" PRIMARY KEY("day","provider")
);
--> statement-breakpoint
CREATE TABLE "providers_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"ok" boolean NOT NULL,
	"latency_ms" integer,
	"http_status" integer,
	"advertised_limits" jsonb,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "request_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"model_class" text,
	"latency_ms" integer,
	"tokens_in" integer,
	"tokens_out" integer,
	"outcome" text NOT NULL,
	"fallback_depth" integer DEFAULT 0 NOT NULL
);
