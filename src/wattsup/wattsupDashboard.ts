import fs from 'fs';
import * as vscode from 'vscode';
import { IExtensionContribution } from '../extension/common/contributions';
import { IVSCodeExtensionContext } from '../platform/extContext/common/extensionContext';
import { IFetcherService } from '../platform/networking/common/fetcherService';
import { IRequestLogger } from '../platform/requestLogger/node/requestLogger';
import { IntervalTimer } from '../util/vs/base/common/async';
import { Disposable } from '../util/vs/base/common/lifecycle';
import equivalencesData from './equivalences.json';

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
		this._register(requestLogger.onDidChangeRequests(async () => {
			const requests = await this.requestLogger.getRequests();
			console.log(`[wattsup] total requests logged: ${requests.length}`);
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
		try {
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