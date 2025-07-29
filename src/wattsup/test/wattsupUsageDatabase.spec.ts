import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Usage, WattsupUsageDatabase } from '../wattsupUsageDatabase';

describe('WattsupUsageDatabase', () => {
	let tempDir: string;
	let database: WattsupUsageDatabase;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(__dirname, 'test-'));
		database = new WattsupUsageDatabase(tempDir);
	});

	afterEach(() => {
		database.dispose();
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it('should initialize with empty CSV file', () => {
		const csvPath = path.join(tempDir, 'usage.csv');
		expect(fs.existsSync(csvPath)).toBe(true);

		const content = fs.readFileSync(csvPath, 'utf-8');
		expect(content).toBe('id,timestamp,provider,model,estimation_model,input_token,output_token,latency,energy_min,energy_max,gwp_min,gwp_max,adpe_min,adpe_max,pe_min,pe_max\n');
	});

	it('should add usage data and compute totals', async () => {
		const usageData: Usage[] = [
			{
				id: 'test-1',
				timestamp: Date.now(),
				provider: 'openai',
				model: 'gpt-4o',
				estimation_model: 'gpt-4o',
				input_token: 100,
				output_token: 50,
				latency: 1000,
				energy_min: 0.1,
				energy_max: 0.2,
				gwp_min: 0.01,
				gwp_max: 0.02,
				adpe_min: 0.001,
				adpe_max: 0.002,
				pe_min: 0.0001,
				pe_max: 0.0002
			}
		];

		await database.addUsage(usageData);

		const totals = database.getTotals('daily');
		expect(totals.totals.count).toBe(1);
		expect(totals.totals.output_token).toBe(50);
	});

	it('should handle concurrent writes with locking', async () => {
		const usageData1: Usage[] = [{
			id: 'test-1',
			timestamp: Date.now(),
			provider: 'openai',
			model: 'gpt-4o',
			estimation_model: 'gpt-4o',
			input_token: 100,
			output_token: 50,
			latency: 1000,
			energy_min: 0.1,
			energy_max: 0.2,
			gwp_min: 0.01,
			gwp_max: 0.02,
			adpe_min: 0.001,
			adpe_max: 0.002,
			pe_min: 0.0001,
			pe_max: 0.0002
		}];

		const usageData2: Usage[] = [{
			id: 'test-2',
			timestamp: Date.now(),
			provider: 'anthropic',
			model: 'claude-3.5-sonnet',
			estimation_model: 'claude-3-5-sonnet-latest',
			input_token: 200,
			output_token: 100,
			latency: 2000,
			energy_min: 0.2,
			energy_max: 0.4,
			gwp_min: 0.02,
			gwp_max: 0.04,
			adpe_min: 0.002,
			adpe_max: 0.004,
			pe_min: 0.0002,
			pe_max: 0.0004
		}];

		// Execute both writes concurrently
		await Promise.all([
			database.addUsage(usageData1),
			database.addUsage(usageData2)
		]);

		const totals = database.getTotals('daily');
		expect(totals.totals.count).toBe(2);
		expect(totals.totals.output_token).toBe(150);
	});
});
