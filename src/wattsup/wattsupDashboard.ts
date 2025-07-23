import fs from 'fs';
import path from 'path';
import * as vscode from 'vscode';
import { IExtensionContribution } from '../extension/common/contributions';
import { IVSCodeExtensionContext } from '../platform/extContext/common/extensionContext';
import { IRequestLogger } from '../platform/requestLogger/node/requestLogger';
import { Disposable } from '../util/vs/base/common/lifecycle';
import equivalencesData from './equivalences.json';

export class WattsupDashboard extends Disposable implements vscode.WebviewViewProvider, IExtensionContribution {
	readonly id = 'wattsupDashboard';
	private _context: IVSCodeExtensionContext;

	constructor(@IVSCodeExtensionContext private readonly context: IVSCodeExtensionContext,
		@IRequestLogger requestLogger: IRequestLogger
	) {
		super();
		this._context = context;
		this._register(vscode.window.registerWebviewViewProvider('copilot-wattsup', this));
		this._register(requestLogger.onDidChangeRequests(async () => {
			const requests = await requestLogger.getRequests();
			console.log(`[wattsup] total requests logged: ${requests.length}`);
		}));
	}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.file(path.join(this._context.extensionPath, 'node_modules')),
				vscode.Uri.file(path.join(this._context.extensionPath, 'src'))
			]
		};

		const htmlPath = path.join(this._context.extensionPath, 'src', 'wattsup', 'wattsupDashboard.html');
		let html = fs.readFileSync(htmlPath, 'utf-8');

		// Get Chart.js URI for webview
		const chartJsPath = path.join(this._context.extensionPath, 'node_modules', 'chart.js', 'dist', 'chart.umd.js');
		const chartJsUri = webviewView.webview.asWebviewUri(vscode.Uri.file(chartJsPath));

		// Inject Chart.js script and equivalences data into the HTML
		const chartJsScript = `<script src="${chartJsUri}"></script>`;
		const equivalencesScript = `<script>window.equivalencesData = ${JSON.stringify(equivalencesData)};</script>`;
		html = html.replace('<script>', chartJsScript + '\n    ' + equivalencesScript + '\n    <script>');

		webviewView.webview.html = html;
	}
}