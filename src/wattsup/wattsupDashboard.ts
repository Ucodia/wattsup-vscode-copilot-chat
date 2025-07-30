import fs from 'fs';
import * as vscode from 'vscode';
import { IExtensionContribution } from '../extension/common/contributions';
import { IVSCodeExtensionContext } from '../platform/extContext/common/extensionContext';
import { ILoggedRequestInfo, IRequestLogger, LoggedInfoKind } from '../platform/requestLogger/node/requestLogger';
import { IntervalTimer } from '../util/vs/base/common/async';
import { Disposable } from '../util/vs/base/common/lifecycle';
import equivalencesData from './data/equivalences.json';
import llmImpact from './llmImpact';
import { Usage, WattsupUsageDatabase } from './wattsupUsageDatabase';

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
	"o4-mini": { provider: "openai", model: "o1-mini" },
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
	private _usageDatabase: WattsupUsageDatabase;
	private _storageDir: string;

	constructor(@IVSCodeExtensionContext private readonly context: IVSCodeExtensionContext,
		@IRequestLogger private readonly requestLogger: IRequestLogger,
		private readonly fetchTimer: IntervalTimer = new IntervalTimer()
	) {
		super();
		this._register(this.fetchTimer);
		this._register(vscode.window.registerWebviewViewProvider('copilot-wattsup', this));

		this._storageDir = vscode.Uri.joinPath(this.context.globalStorageUri, 'wattsup').fsPath;
		this._usageDatabase = this._register(new WattsupUsageDatabase(this._storageDir));
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
					this.fetchAndSchedule();
					break;
			}
		}));

		this._register(webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible) {
				this.fetchAndSchedule();
			} else {
				this.fetchTimer.cancel();
			}
		}));

		this.fetchAndSchedule();
	}

	private fetchAndSchedule(): void {
		this.fetchAndNotify();
		this.fetchTimer.cancelAndSet(() => {
			this.fetchAndNotify();
		}, 10000);
	}

	private async fetchAndNotify(): Promise<void> {
		const requests = await this.requestLogger.getRequests()
		const formattedRequests = requests
			.filter(request => request.kind === LoggedInfoKind.Request)
			.filter(request => !this._processedRequests.includes(request.id))
			.map((request: ILoggedRequestInfo) => {
				const data: Partial<Usage> = {};
				const entry = request.entry as any;
				data.id = request.id;
				data.timestamp = entry.startTime?.getTime() || 0;
				data.model = entry.chatParams?.model || 'unknown';
				data.input_token = entry.usage?.prompt_tokens || 0;
				data.output_token = entry.usage?.completion_tokens || 0;
				data.latency = (entry.endTime && entry.startTime) ? entry.endTime - entry.startTime : 0;

				try {
					const { model, provider } = getProviderAndModelName(data.model!);
					data.provider = provider;
					data.estimation_model = model;

					const impact = llmImpact(provider, model, data.output_token!, data.latency!);
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
				}

				return data as Usage;
			}).filter(request => request.provider !== 'unknown'); // filter unprocessed requests

		if (formattedRequests.length > 0) {
			try {
				await this._usageDatabase.addUsage(formattedRequests);
			} catch (error) {
				console.error('[wattsup] Error adding usage data to database', error);
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
			const statsData = this._usageDatabase.getTotals(this._currentPeriod);

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
}