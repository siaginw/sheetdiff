ALTER TABLE `spreadsheets` ADD `capture_fail_streak` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `spreadsheets` ADD `last_capture_error` text;--> statement-breakpoint
ALTER TABLE `spreadsheets` ADD `last_capture_error_at` integer;