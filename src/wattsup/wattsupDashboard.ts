import fs from 'fs';
import * as vscode from 'vscode';
import { IExtensionContribution } from '../extension/common/contributions';
import { IVSCodeExtensionContext } from '../platform/extContext/common/extensionContext';
import { ILoggedRequestInfo, IRequestLogger, LoggedInfoKind } from '../platform/requestLogger/node/requestLogger';
import { IntervalTimer } from '../util/vs/base/common/async';
import { Disposable } from '../util/vs/base/common/lifecycle';
import { findModel, findProviderByModel, llmImpact } from './llmImpact';
import { Usage, WattsupUsageDatabase } from './wattsupUsageDatabase';

export class WattsupDashboard extends Disposable implements vscode.WebviewViewProvider, IExtensionContribution {
	readonly id = 'wattsupDashboard';
	private _webviewView: vscode.WebviewView | undefined;
	private _currentPeriod: string = 'day';
	private _processedRequests: string[] = [];
	private _usageDatabase: WattsupUsageDatabase;
	private _storageDir: vscode.Uri;

	constructor(@IVSCodeExtensionContext private readonly context: IVSCodeExtensionContext,
		@IRequestLogger private readonly requestLogger: IRequestLogger,
		private readonly fetchTimer: IntervalTimer = new IntervalTimer()
	) {
		super();
		this._register(this.fetchTimer);
		this._register(vscode.window.registerWebviewViewProvider('copilot-wattsup', this));

		this._storageDir = vscode.Uri.joinPath(this.context.globalStorageUri, '..', 'wattsup');
		this._usageDatabase = this._register(new WattsupUsageDatabase(this._storageDir.fsPath));

		this._register(vscode.commands.registerCommand('wattsup.exportUsage', async () => {
			const csvPath = vscode.Uri.joinPath(this._storageDir, 'usage.csv');
			const exportUri = await vscode.window.showSaveDialog({
				defaultUri: vscode.Uri.file('wattsup-vscode-copilot-usage.csv'),
				filters: { 'CSV': ['csv'] }
			});
			if (!exportUri) {
				return;
			}
			await vscode.workspace.fs.copy(csvPath, exportUri, { overwrite: true });
			vscode.window.showInformationMessage(`Usage downloaded to ${exportUri.fsPath}`);
		}));
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

		// inject Chart.js into the HTML
		const chartJsPath = vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'chart.js', 'dist', 'chart.umd.js');
		const chartJsUri = webviewView.webview.asWebviewUri(chartJsPath);
		const chartJsScript = `<script src="${chartJsUri}"></script>`;
		html = html.replace('<script>', chartJsScript + '\n    <script>');

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
					const provider = findProviderByModel(data.model!);
					const estimationModel = findModel(provider!, data.model!);

					if (!estimationModel) {
						throw new Error(`Could not find model and provider for ${data.model}`)
					}

					data.provider = estimationModel.provider;
					data.estimation_model = estimationModel.name;

					const impact = llmImpact(data.provider!, data.estimation_model!, data.output_token!, data.latency!);
					data.energy_min = impact.energy.min;
					data.energy_max = impact.energy.max;
					data.gwp_min = impact.gwp.min;
					data.gwp_max = impact.gwp.max;
					data.adpe_min = impact.adpe.min;
					data.adpe_max = impact.adpe.max;
					data.pe_min = impact.pe.min;
					data.pe_max = impact.pe.max;
				} catch (error) {
					console.warn(`[wattsup] Could not process usage for model ${data.model}, skipping impact calculation`);
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
			// keep only the last 100 processed requests to prevent infinite growth
			// the request logger implementation only stores the last 100 requests
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