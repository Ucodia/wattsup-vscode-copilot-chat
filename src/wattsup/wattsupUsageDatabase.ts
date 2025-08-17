import * as aq from 'arquero';
import fs from 'fs';
import path from 'path';
import * as vscode from 'vscode';
import { Disposable } from '../util/vs/base/common/lifecycle';
import equivalencesData from './data/equivalences.json';

export interface Usage {
	id: string;
	timestamp: number;
	provider: string;
	model: string;
	estimation_model: string;
	input_token: number;
	output_token: number;
	latency: number;
	energy_min: number;
	energy_max: number;
	gwp_min: number;
	gwp_max: number;
	adpe_min: number;
	adpe_max: number;
	pe_min: number;
	pe_max: number;
}

export interface Equivalence {
	label: string;
	emoji: string;
	value: number;
	unit: string;
	enabled: boolean;
}

export interface UsageTotals {
	aggregates: {
		labels: string[];
		data: Array<{
			model_name: string;
			data: {
				energy_avg: number[];
				gwp_avg: number[];
				output_token: number[];
			};
		}>;
	};
	totals: {
		energy_avg: number;
		gwp_avg: number;
		output_token: number;
		count: number;
	};
	equivalences: Array<{
		equivalence: Equivalence;
		value: number;
	}>;
}

const csvHeader = [
	'id', 'timestamp', 'provider', 'model', 'estimation_model', 'input_token', 'output_token', 'latency',
	'energy_min', 'energy_max', 'gwp_min', 'gwp_max', 'adpe_min', 'adpe_max', 'pe_min', 'pe_max'
];

export class WattsupUsageDatabase extends Disposable {
	private _usageTable: aq.ColumnTable = aq.fromCSV(csvHeader.join(',') + '\n');
	private _csvFilePath: string;
	private _lockFilePath: string;
	private _fileWatcher: vscode.FileSystemWatcher | undefined;
	private _lastFileSize: number = 0;

	constructor(private readonly storageDir: string) {
		super();
		this._csvFilePath = path.join(storageDir, 'usage.csv');
		this._lockFilePath = path.join(storageDir, 'usage.csv.lock');

		this.initializeStorage();
		this.loadUsageFromFile();
		this.setupFileWatcher();
	}

	private initializeStorage(): void {
		if (!fs.existsSync(this.storageDir)) {
			fs.mkdirSync(this.storageDir, { recursive: true });
		}
		if (!fs.existsSync(this._csvFilePath)) {
			fs.writeFileSync(this._csvFilePath, csvHeader.join(',') + '\n');
		}
	}

	private loadUsageFromFile(): void {
		try {
			const csvContent = fs.readFileSync(this._csvFilePath, 'utf-8');
			this._lastFileSize = csvContent.length;
			this._usageTable = aq.fromCSV(csvContent);
		} catch (error) {
			console.error('[wattsup] Error loading table from CSV, creating empty table:', error);
			this._lastFileSize = 0;
		}
	}

	private setupFileWatcher(): void {
		try {
			// check if vscode.workspace is available (not in test environment)
			if (typeof vscode !== 'undefined' && vscode.workspace && vscode.workspace.createFileSystemWatcher) {
				this._fileWatcher = vscode.workspace.createFileSystemWatcher(
					new vscode.RelativePattern(vscode.Uri.file(this.storageDir), '*.csv'),
					true,
					false,
					true
				);

				this._register(this._fileWatcher.onDidChange((uri) => {
					if (uri.fsPath === this._csvFilePath) {
						this.handleFileChange();
					}
				}));

				this._register(this._fileWatcher);
			}
		} catch (error) {
			console.error('[wattsup] Error setting up file watcher:', error);
		}
	}

	private async handleFileChange(): Promise<void> {
		try {
			// read only new lines since last update
			const currentContent = fs.readFileSync(this._csvFilePath, 'utf-8');
			const currentSize = currentContent.length;

			if (currentSize <= this._lastFileSize) {
				// file was truncated or no new content, reload entirely
				this.loadUsageFromFile();
				return;
			}

			const newContent = currentContent.substring(this._lastFileSize);
			const newLines = newContent.trim().split('\n').filter(line => line.trim() !== '');

			if (newLines.length > 0) {
				const newCsv = [csvHeader.join(','), ...newLines].join('\n');
				const newRows = aq.fromCSV(newCsv);
				if (newRows.numRows() > 0) {
					this._usageTable = this._usageTable.concat(newRows);
				}
			}

			this._lastFileSize = currentSize;
		} catch (error) {
			console.error('[wattsup] Error handling file change:', error);
			this.loadUsageFromFile();
		}
	}

	private async acquireLock(retryCount = 0): Promise<void> {
		const maxRetries = 10;
		const retryDelay = 100; // ms

		try {
			// Create lock file atomically
			fs.writeFileSync(this._lockFilePath, process.pid.toString(), { flag: 'wx' });
		} catch (error: any) {
			if (error.code === 'EEXIST' && retryCount < maxRetries) {
				// Lock file exists, wait and retry
				await new Promise(resolve => setTimeout(resolve, retryDelay * Math.pow(2, retryCount)));
				return this.acquireLock(retryCount + 1);
			} else {
				throw new Error(`Failed to acquire lock after ${maxRetries} retries: ${error.message}`);
			}
		}
	}

	private releaseLock(): void {
		try {
			if (fs.existsSync(this._lockFilePath)) {
				fs.unlinkSync(this._lockFilePath);
			}
		} catch (error) {
			console.error('[wattsup] Error releasing lock:', error);
		}
	}

	async addUsage(usages: Usage[]): Promise<void> {
		if (usages.length === 0) {
			return;
		}

		try {
			await this.acquireLock();

			// Convert usages to CSV lines
			const csvLines = usages.map(usage => [
				usage.id,
				usage.timestamp,
				usage.provider,
				usage.model,
				usage.estimation_model,
				usage.input_token,
				usage.output_token,
				usage.latency,
				usage.energy_min,
				usage.energy_max,
				usage.gwp_min,
				usage.gwp_max,
				usage.adpe_min,
				usage.adpe_max,
				usage.pe_min,
				usage.pe_max
			].join(','));

			// Append to file
			const newContent = csvLines.join('\n') + '\n';
			fs.appendFileSync(this._csvFilePath, newContent);

			// Update memory table
			const newRows = aq.from(usages);
			this._usageTable = this._usageTable.concat(newRows);

			// Update file size tracking
			this._lastFileSize = fs.statSync(this._csvFilePath).size;
		} catch (error) {
			console.error('[wattsup] Error adding usage data:', error);
			throw error;
		} finally {
			this.releaseLock();
		}
	}

	getTotals(period: string): UsageTotals {
		const periodEndMs = new Date().getTime();
		let intervalMs: number;
		let periodCount: number;

		if (period === 'hour') {
			intervalMs = 5 * 60 * 1000; // 5 min
			periodCount = 12;
		} else if (period === 'day') {
			intervalMs = 60 * 60 * 1000; // 1 h
			periodCount = 24;
		} else if (period === 'week') {
			intervalMs = 24 * 60 * 60 * 1000; // 1 day
			periodCount = 7;
		} else if (period === 'month') {
			intervalMs = 24 * 60 * 60 * 1000; // 1 day
			periodCount = 30;
		} else {
			throw new Error(`Invalid time period: ${period}`);
		}

		const periodStartMs = periodEndMs - (periodCount * intervalMs);
		const floorTimestamp = (timestamp: number) => Math.floor(timestamp / intervalMs) * intervalMs;

		const filteredUsage = this._usageTable
			.filter(aq.escape((d: any) => d.timestamp >= periodStartMs && d.timestamp <= periodEndMs))
			.derive({
				energy_avg: aq.escape((d: any) => (d.energy_min + d.energy_max) / 2),
				gwp_avg: aq.escape((d: any) => (d.gwp_min + d.gwp_max) / 2),
				pe_avg: aq.escape((d: any) => (d.pe_min + d.pe_max) / 2),
				time_group: aq.escape((d: any) => new Date(floorTimestamp(d.timestamp)))
			});

		const groupedUsage = filteredUsage
			.groupby('model', 'time_group')
			.rollup({
				output_token_total: (d: any) => aq.op.sum(d.output_token),
				energy_total: (d: any) => aq.op.sum(d.energy_avg),
				gwp_total: (d: any) => aq.op.sum(d.gwp_avg),
				count: aq.op.count()
			})
			.orderby('time_group', 'model');

		const timePeriods: string[] = [];
		const lastLabelTimestamp = floorTimestamp(periodEndMs);
		for (let i = 0; i < periodCount; i++) {
			const labelTimestamp = lastLabelTimestamp - (periodCount - 1 - i) * intervalMs;
			timePeriods.push(new Date(labelTimestamp).toISOString());
		}
		const models = groupedUsage.ungroup().dedupe('model').objects().map((d: any) => d.model);
		const groupedData = groupedUsage.objects();

		const data = [];
		for (const model of models) {
			const modelData: {
				energy_avg: number[],
				gwp_avg: number[],
				output_token: number[]
			} = {
				energy_avg: Array(timePeriods.length).fill(0),
				gwp_avg: Array(timePeriods.length).fill(0),
				output_token: Array(timePeriods.length).fill(0)
			};

			const modelRows = groupedData.filter((r: any) => r.model === model);

			for (const row of modelRows) {
				const rowData = row as any;
				const labelIndex = timePeriods.indexOf((rowData.time_group as Date).toISOString());
				if (labelIndex !== -1) {
					modelData.energy_avg[labelIndex] = rowData.energy_total;
					modelData.gwp_avg[labelIndex] = rowData.gwp_total;
					modelData.output_token[labelIndex] = rowData.output_token_total;
				}
			}

			data.push({
				model_name: model,
				data: modelData
			});
		}

		const usageTotals = groupedUsage.rollup({
			energy_total: (d: any) => aq.op.sum(d.energy_total),
			gwp_total: (d: any) => aq.op.sum(d.gwp_total),
			output_token_total: (d: any) => aq.op.sum(d.output_token_total),
			count: (d: any) => aq.op.sum(d.count)
		}).objects()[0] as any;

		const equivalences = equivalencesData.filter(eq => eq.enabled).map(eq => ({
			equivalence: eq,
			value: eq.unit === "kgCO2eq" ? usageTotals.gwp_total / eq.value : usageTotals.energy_total / eq.value
		}));

		return {
			aggregates: {
				labels: timePeriods,
				data: data,
			},
			totals: {
				energy_avg: usageTotals?.energy_total || 0,
				gwp_avg: usageTotals?.gwp_total || 0,
				output_token: usageTotals?.output_token_total || 0,
				count: usageTotals?.count || 0
			},
			equivalences: equivalences
		};
	}

	override dispose(): void {
		this.releaseLock();
		super.dispose();
	}
}
