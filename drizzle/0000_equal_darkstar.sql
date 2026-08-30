CREATE TABLE `change_acks` (
	`id` text PRIMARY KEY NOT NULL,
	`tab_id` text NOT NULL,
	`row_key` text NOT NULL,
	`acked_at` integer NOT NULL,
	FOREIGN KEY (`tab_id`) REFERENCES `tabs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `change_acks_tab_row_idx` ON `change_acks` (`tab_id`,`row_key`);--> statement-breakpoint
CREATE TABLE `members` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`email` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `members_owner_email_idx` ON `members` (`owner_user_id`,lower("email"));--> statement-breakpoint
CREATE TABLE `notes` (
	`id` text PRIMARY KEY NOT NULL,
	`spreadsheet_id` text NOT NULL,
	`tab_id` text,
	`run_id` text,
	`row_key` text,
	`body` text NOT NULL,
	`author_user_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`spreadsheet_id`) REFERENCES `spreadsheets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tab_id`) REFERENCES `tabs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notes_sheet_created_idx` ON `notes` (`spreadsheet_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `snapshot_stats` (
	`snapshot_id` text PRIMARY KEY NOT NULL,
	`tab_id` text NOT NULL,
	`added` integer NOT NULL,
	`removed` integer NOT NULL,
	`changed` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`snapshot_id`) REFERENCES `snapshots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `snapshot_stats_tab_idx` ON `snapshot_stats` (`tab_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`tab_id` text NOT NULL,
	`run_id` text NOT NULL,
	`trigger` text NOT NULL,
	`is_baseline` integer DEFAULT false NOT NULL,
	`row_count` integer NOT NULL,
	`col_count` integer NOT NULL,
	`data_blob` blob NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tab_id`) REFERENCES `tabs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `snapshots_tab_created_idx` ON `snapshots` (`tab_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `snapshots_run_idx` ON `snapshots` (`run_id`);--> statement-breakpoint
CREATE TABLE `spreadsheets` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`google_id` text NOT NULL,
	`title` text NOT NULL,
	`url` text NOT NULL,
	`schedule_kind` text DEFAULT 'off' NOT NULL,
	`schedule_hours` integer,
	`schedule_time` text,
	`schedule_day` integer,
	`next_run_at` integer,
	`last_snapshot_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tabs` (
	`id` text PRIMARY KEY NOT NULL,
	`spreadsheet_id` text NOT NULL,
	`title` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`tracked` integer DEFAULT true NOT NULL,
	`key_column` integer,
	FOREIGN KEY (`spreadsheet_id`) REFERENCES `spreadsheets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tabs_spreadsheet_idx` ON `tabs` (`spreadsheet_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tabs_spreadsheet_title_idx` ON `tabs` (`spreadsheet_id`,`title`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`google_sub` text NOT NULL,
	`email` text,
	`name` text,
	`avatar_url` text,
	`tokens_enc` text NOT NULL,
	`digest_email` text,
	`digest_time` text DEFAULT '07:00' NOT NULL,
	`digest_day` integer,
	`last_digest_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_google_sub_unique` ON `users` (`google_sub`);