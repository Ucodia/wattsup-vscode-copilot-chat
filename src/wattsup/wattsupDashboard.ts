import * as aq from 'arquero';
import fs from 'fs';
import * as vscode from 'vscode';
import { IExtensionContribution } from '../extension/common/contributions';
import { IVSCodeExtensionContext } from '../platform/extContext/common/extensionContext';
import { IFetcherService } from '../platform/networking/common/fetcherService';
import { ILoggedRequestInfo, IRequestLogger, LoggedInfoKind } from '../platform/requestLogger/node/requestLogger';
import { IntervalTimer } from '../util/vs/base/common/async';
import { Disposable } from '../util/vs/base/common/lifecycle';
import equivalencesData from './data/equivalences.json';
import llmImpact from './llmImpact';

interface ModelMapping {
	provider: string;
	model: string;
}

const csvHeader = [
	'id', 'timestamp', 'provider', 'model', 'estimation_model', 'input_token', 'output_token', 'latency',
	'energy_min', 'energy_max', 'gwp_min', 'gwp_max', 'adpe_min', 'adpe_max', 'pe_min', 'pe_max'
]

const modelMap: Record<string, ModelMapping> = {
	// anthropic
	"claude-3.5-sonnet": { provider: "anthropic", model: "claude-3-5-sonnet-latest" },
	"claude-3.7-sonnet-thought": { provider: "anthropic", model: "claude-3-7-sonnet-latest" },
	"claude-3.7-sonnet": { provider: "anthropic", model: "claude-3-7-sonnet-latest" },
	"claude-sonnet-4": { provider: "anthropic", model: "claude-3-7-sonnet-latest" },
	// google
	"gemini-2.0-flash-001": { provider: "google", model: "gemini-2.0-flash-001" },
	// openai
	"gpt-4.1": { provider: "openai", model: "gpt-4" },
	"gpt-4o": { provider: "openai", model: "gpt-4o" },
	"gpt-4o-mini": { provider: "openai", model: "gpt-4o-mini" },
	"o1-mini": { provider: "openai", model: "o1-mini" },
	"o3-mini": { provider: "openai", model: "o1-mini" },
};

function getProviderAndModelName(originalModelName: string): ModelMapping {
	if (originalModelName in modelMap) {
		return modelMap[originalModelName];
	} else {
		throw new Error(
			`Could not find estimation for model name: ${originalModelName}.`
		);
	}
}

export class WattsupDashboard extends Disposable implements vscode.WebviewViewProvider, IExtensionContribution {
	readonly id = 'wattsupDashboard';
	private _webviewView: vscode.WebviewView | undefined;
	private _currentPeriod: string = 'daily';
	private _processedRequests: string[] = [];
	private _usageTable: aq.ColumnTable;
	private _storageDir: string;
	private _csvFilePath: string;

	constructor(@IVSCodeExtensionContext private readonly context: IVSCodeExtensionContext,
		@IRequestLogger private readonly requestLogger: IRequestLogger,
		@IFetcherService private readonly fetcherService: IFetcherService,
		private readonly fetchTimer: IntervalTimer = new IntervalTimer()
	) {
		super();
		this._register(this.fetchTimer);
		this._register(vscode.window.registerWebviewViewProvider('copilot-wattsup', this));

		this._storageDir = vscode.Uri.joinPath(this.context.globalStorageUri, 'wattsup').fsPath;
		this._csvFilePath = vscode.Uri.joinPath(this.context.globalStorageUri, 'wattsup', 'usage.csv').fsPath;
		this.initializeStorage();
		this._usageTable = this.initializeUsageTable();
	}

	private initializeStorage(): void {
		if (!fs.existsSync(this._storageDir)) {
			fs.mkdirSync(this._storageDir, { recursive: true });
		}
		if (!fs.existsSync(this._csvFilePath)) {
			fs.writeFileSync(this._csvFilePath, csvHeader.join(',') + '\n');
		}
	}

	private initializeUsageTable(): aq.ColumnTable {
		let usageTable: aq.ColumnTable;
		try {
			const csvContent = fs.readFileSync(this._csvFilePath, 'utf-8');
			usageTable = aq.fromCSV(csvContent);
		} catch (error) {
			console.error('[wattsup] Error loading table from CSV, creating empty table:', error);
			usageTable = aq.fromCSV(csvHeader.join(',') + '\n');
		}
		return usageTable
	}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this._webviewView = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(this.context.extensionUri, 'node_modules'),
				vscode.Uri.joinPath(this.context.extensionUri, 'src')
			]
		};

		const htmlUri = vscode.Uri.joinPath(this.context.extensionUri, 'src', 'wattsup', 'wattsupDashboard.html');
		let html = fs.readFileSync(htmlUri.fsPath, 'utf-8');

		// Inject Chart.js and equivalences data into the HTML
		const chartJsPath = vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'chart.js', 'dist', 'chart.umd.js');
		const chartJsUri = webviewView.webview.asWebviewUri(chartJsPath);
		const chartJsScript = `<script src="${chartJsUri}"></script>`;
		const equivalencesScript = `<script>window.equivalencesData = ${JSON.stringify(equivalencesData)};</script>`;
		html = html.replace('<script>', chartJsScript + '\n    ' + equivalencesScript + '\n    <script>');

		webviewView.webview.html = html;

		this._register(webviewView.webview.onDidReceiveMessage(message => {
			switch (message.type) {
				case 'wattsupRequestDataRefresh':
					this._currentPeriod = message.period || this._currentPeriod;
					this.fetchDataAndNotify();
					this.schedulePeriodicFetch();
					break;
			}
		}));

		this.schedulePeriodicFetch();
	}

	private schedulePeriodicFetch(): void {
		this.fetchTimer.cancelAndSet(() => {
			this.fetchDataAndNotify();
		}, 10000);
	}

	private async fetchDataAndNotify(): Promise<void> {
		const requests = await this.requestLogger.getRequests()
		const formattedRequests = requests
			.filter(request => request.kind === LoggedInfoKind.Request)
			.filter(request => !this._processedRequests.includes(request.id))
			.map((request: ILoggedRequestInfo) => {
				const data: Record<string, any> = {};
				const entry = request.entry as any;
				data.id = request.id;
				data.timestamp = entry.startTime?.getTime() || 0;
				data.model = entry.chatParams?.model || 'unknown';
				data.input_token = entry.usage?.prompt_tokens || 0;
				data.output_token = entry.usage?.completion_tokens || 0;
				data.latency = (entry.endTime && entry.startTime) ? entry.endTime - entry.startTime : 0;

				try {
					const { model, provider } = getProviderAndModelName(data.model);
					data.provider = provider;
					data.estimation_model = model;

					const impact = llmImpact(provider, model, data.output_token, data.latency);
					data.energy_min = impact.energy.min;
					data.energy_max = impact.energy.max;
					data.gwp_min = impact.gwp.min;
					data.gwp_max = impact.gwp.max;
					data.adpe_min = impact.adpe.min;
					data.adpe_max = impact.adpe.max;
					data.pe_min = impact.pe.min;
					data.pe_max = impact.pe.max;
				} catch (error) {
					console.warn(`[wattsup] Could not process model ${data.model}, skipping impact calculation`);
					data.provider = 'unknown';
					data.estimation_model = 'unknown';
					data.energy_min = 0;
					data.energy_max = 0;
					data.gwp_min = 0;
					data.gwp_max = 0;
					data.adpe_min = 0;
					data.adpe_max = 0;
					data.pe_min = 0;
					data.pe_max = 0;
				}

				return data;
			}).filter(request => request.energy_min !== 0); // filter unprocessed requests

		if (formattedRequests.length > 0) {
			const newRows = aq.from(formattedRequests);
			this._usageTable = this._usageTable.concat(newRows);

			try {
				fs.writeFileSync(this._csvFilePath, this._usageTable.toCSV());
			} catch (error) {
				console.error('[wattsup] Error writing usage table to CSV file', error);
			}

			formattedRequests.forEach(request => {
				this._processedRequests.push(request.id);
			});
			// keep only the last 100 processed requests
			if (this._processedRequests.length > 100) {
				this._processedRequests.splice(0, this._processedRequests.length - 100);
			}
		}

		try {
			// old backend fetch
			// const response = await fetch(`http://localhost:9999/stats?period=${this._currentPeriod}`);
			// const statsData = await response.json();
			const statsData = this.computeStats(this._currentPeriod);

			if (this._webviewView) {
				this._webviewView.webview.postMessage({
					type: 'wattsupDataRefreshed',
					data: statsData
				});
			}
		} catch (error) {
			console.error('[wattsup] Error computing stats:', error);
		}
	}

	private computeStats(period: string): any {
		const periodEndMs = new Date().getTime();
		let intervalMs: number;
		let periodCount: number;

		if (period === 'hourly') {
			intervalMs = 5 * 60 * 1000;
			periodCount = 12;
		} else if (period === 'daily') {
			intervalMs = 60 * 60 * 1000;
			periodCount = 24;
		} else if (period === 'monthly') {
			intervalMs = 24 * 60 * 60 * 1000;
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

		groupedUsage.print();

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
				const labelIndex = timePeriods.indexOf((row.time_group as Date).toISOString());
				if (labelIndex !== -1) {
					modelData.energy_avg[labelIndex] = row.energy_total;
					modelData.gwp_avg[labelIndex] = row.gwp_total;
					modelData.output_token[labelIndex] = row.output_token_total;
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
		}).objects()[0];

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
			}
		};
	}
}