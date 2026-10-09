import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import type { Database } from "../../src/database/types.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { listColumns, resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

/**
 * Field creation on a collection whose table is at D1's column cap.
 *
 * D1 allows 100 columns per table. A new collection's table has 15 system
 * columns, so FIELD_COUNT fields fill it and the next `ALTER TABLE ... ADD
 * COLUMN` fails. D1 runs `createField` without a transaction, so nothing rolls
 * back the field row written before that statement.
 */
const COLLECTION = "full_d1";
const MAX_TABLE_WIDTH = 100;
const FIELD_COUNT = 85;
const OVERFLOW_FIELD = { slug: "overflow", label: "Overflow", type: "string" } as const;

let db: Kysely<Database>;
let registry: SchemaRegistry;

beforeAll(async () => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
	await resetD1Schema(db);
	await runMigrations(db);

	registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: COLLECTION, label: "Full D1" });
	for (let i = 1; i <= FIELD_COUNT; i++) {
		await registry.createField(COLLECTION, {
			slug: `field_${i}`,
			label: `Field ${i}`,
			type: "string",
		});
	}
});

afterAll(async () => {
	await db.destroy();
});

describe("createField at D1's column cap", () => {
	it("fills the table to the cap", async () => {
		expect(await listColumns(db, `ec_${COLLECTION}`)).toHaveLength(MAX_TABLE_WIDTH);
	});

	it("leaves no field row behind when the column cannot be added", async () => {
		await expect(registry.createField(COLLECTION, OVERFLOW_FIELD)).rejects.toThrow(
			/too many columns/,
		);
		expect(await registry.getField(COLLECTION, OVERFLOW_FIELD.slug)).toBeNull();

		await expect(registry.createField(COLLECTION, OVERFLOW_FIELD)).rejects.toThrow(
			/too many columns/,
		);
	});

	it("creates the rejected field once a column is freed", async () => {
		await registry.deleteField(COLLECTION, "field_1");

		const created = await registry.createField(COLLECTION, OVERFLOW_FIELD);

		expect(created.slug).toBe(OVERFLOW_FIELD.slug);
		const columns = await listColumns(db, `ec_${COLLECTION}`);
		expect(columns).toHaveLength(MAX_TABLE_WIDTH);
		expect(columns).toContain(OVERFLOW_FIELD.slug);
	});
});
