import * as dfd from 'danfojs-node';
import fs from 'fs';
import * as vscode from 'vscode';
import { IExtensionContribution } from '../extension/common/contributions';
import { IVSCodeExtensionContext } from '../platform/extContext/common/extensionContext';
import { IFetcherService } from '../platform/networking/common/fetcherService';
import { IRequestLogger } from '../platform/requestLogger/node/requestLogger';
import { IntervalTimer } from '../util/vs/base/common/async';
import { Disposable } from '../util/vs/base/common/lifecycle';
import equivalencesData from './data/equivalences.json';
import llmImpact from './llmImpact';

interface ModelMapping {
	provider: string;
	model: string;
}

const csvHeader = [
	'id', 'timestamp', 'model', 'provider', 'estimation_model', 'input_token', 'output_token', 'latency',
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
	private _processedRequests: Set<string> = new Set();
	private _dataframe: dfd.DataFrame | undefined;
	private _storageDir: string;
	private _csvFilePath: string;

	constructor(@IVSCodeExtensionContext private readonly context: IVSCodeExtensionContext,
		@IRequestLogger private readonly requestLogger: IRequestLogger,
		@IFetcherService private readonly fetcherService: IFetcherService,
		private readonly fetchTimer: IntervalTimer = new IntervalTimer()
	) {
		console.log('[wattsup] Initializing Wattsup Dashboard...');
		super();
		this._register(this.fetchTimer);
		this._register(vscode.window.registerWebviewViewProvider('copilot-wattsup', this));

		this._storageDir = vscode.Uri.joinPath(this.context.globalStorageUri, 'wattsup').fsPath;
		this._csvFilePath = vscode.Uri.joinPath(this.context.globalStorageUri, 'wattsup', 'usage.csv').fsPath;
		this.initializeStorage();
		this.loadDataframe();
		console.log(`[wattsup] Initialized Wattsup Dashboard`);
	}

	private initializeStorage(): void {
		if (!fs.existsSync(this._storageDir)) {
			fs.mkdirSync(this._storageDir, { recursive: true });
			console.log(`[wattsup] Created storage directory: ${this._storageDir}`);
		}
		if (!fs.existsSync(this._csvFilePath)) {
			fs.writeFileSync(this._csvFilePath, csvHeader.join(',') + '\n');
			console.log(`[wattsup] Created CSV file: ${this._csvFilePath}`);
		}
	}

	private async loadDataframe(): Promise<void> {
		// try {
		// 	// Load dataframe from CSV file
		// 	this._dataframe = await dfd.readCSV(this._csvFilePath);
		// 	console.log(`[wattsup] Loaded dataframe with ${this._dataframe.shape[0]} rows`);
		// } catch (error) {
		// 	console.error('[wattsup] Error loading dataframe:', error);
		// 	// Create empty dataframe with expected columns if loading fails
		// 	const emptyData = {
		// 		id: [], model: [], provider: [], estimationModel: [], inputToken: [], outputToken: [],
		// 		latency: [], timestamp: [], energy_min: [], energy_max: [], gwp_min: [], gwp_max: [],
		// 		adpe_min: [], adpe_max: [], pe_min: [], pe_max: []
		// 	};
		// 	this._dataframe = new dfd.DataFrame(emptyData);
		// }
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

		this.fetchDataAndNotify();
		this.schedulePeriodicFetch();
	}

	private async fetchDataAndNotify(): Promise<void> {
		console.log('[wattsup] Fetching request data...');

		const requests = await this.requestLogger.getRequests()
		const formattedRequests = requests.filter(request => !this._processedRequests.has(request.id)).map(request => {
			const data: Record<string, any> = {};
			const entry = request.entry;
			data.id = request.id;
			data.timestamp = entry.startTime.getTime();
			data.model = entry.chatParams.model;
			data.input_token = entry.usage.prompt_tokens;
			data.output_token = entry.usage.completion_tokens;
			data.latency = entry.endTime - entry.startTime;

			const { model, provider, } = getProviderAndModelName(data.model);
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

			return data;
		});

		if (formattedRequests.length === 0) {
			console.log('[wattsup] No new requests to process.');
			return;
		}

		if (formattedRequests.length > 0) {
			try {
				// // Add entries to dataframe
				// const newDataframe = new dfd.DataFrame(formattedRequests);
				// const concatenated = dfd.concat({ dfList: [this._dataframe, newDataframe], axis: 0 });
				// this._dataframe = concatenated as DataFrame;

				// // Save to CSV
				// this._dataframe.toCSV(this._csvFilePath);

				// Add request IDs to _processedRequests
				formattedRequests.forEach(request => {
					this._processedRequests.add(request.id);
				});

				// Truncate _processedRequests to 100 last entries
				// if (this._processedRequests.size > 100) {
				// 	const requestsArray = Array.from(this._processedRequests);
				// 	const toKeep = requestsArray.slice(-100);
				// 	this._processedRequests.clear();
				// 	toKeep.forEach(id => this._processedRequests.add(id));
				// }

				console.log(`[wattsup] Added ${formattedRequests.length} new requests to dataframe.`);
			} catch (error) {
				console.error('[wattsup] Error processing formatted requests:', error);
			}
		}

		try {
			// TODO: replace fetch call with data frame queries
			const response = await this.fetcherService.fetch(`http://localhost:9999/stats?period=${this._currentPeriod}`, {
				method: 'GET',
			});
			const statsData = await response.json();

			if (this._webviewView) {
				this._webviewView.webview.postMessage({
					type: 'wattsupDataRefreshed',
					data: statsData
				});
			}
		} catch (error) {
			console.error('[wattsup] Error fetching data:', error);
		}
	}

	private schedulePeriodicFetch(): void {
		this.fetchTimer.cancelAndSet(() => {
			this.fetchDataAndNotify();
		}, 10000);
	}
}