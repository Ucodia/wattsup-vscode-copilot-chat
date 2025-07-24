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

	constructor(@IVSCodeExtensionContext private readonly context: IVSCodeExtensionContext,
		@IRequestLogger private readonly requestLogger: IRequestLogger,
		@IFetcherService private readonly fetcherService: IFetcherService,
		private readonly fetchTimer: IntervalTimer = new IntervalTimer()
	) {
		super();
		this._register(this.fetchTimer);
		this._register(vscode.window.registerWebviewViewProvider('copilot-wattsup', this));
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
		const formattedRequests = requests.map(request => {
			const data: Record<string, any> = {};
			const entry = request.entry;
			data.id = request.id;
			data.model = entry.chatParams.model;
			data.inputToken = entry.usage.prompt_tokens;
			data.outputToken = entry.usage.completion_tokens;
			data.latency = entry.endTime - entry.startTime;
			data.timestamp = entry.startTime.getTime();

			const { model, provider, } = getProviderAndModelName(data.model);
			data.provider = provider;
			data.estimationModel = model;

			const impact = llmImpact(provider, model, data.outputToken, data.latency);
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


		if (formattedRequests.length !== 0) {
			console.log(`[wattsup] found ${formattedRequests.length} requests:\n${JSON.stringify(formattedRequests, null, 2)}`);
		}

		// TODO: add new data to dataframe, dump as a local csv file

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