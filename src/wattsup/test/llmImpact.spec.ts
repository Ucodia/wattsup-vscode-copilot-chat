import { describe, expect, it } from 'vitest';
import { findModel, findProviderByModel } from '../llmImpact';

describe('llmImpact', () => {
	const modelMap: [string, [string, string]][] = [
		["claude-3.5-sonnet", ["anthropic", "claude-3-5-sonnet-latest"]],
		["claude-3.7-sonnet-thought", ["anthropic", "claude-3-7-sonnet-latest"]],
		["claude-3.7-sonnet", ["anthropic", "claude-3-7-sonnet-latest"]],
		["claude-sonnet-4", ["anthropic", "claude-sonnet-4-20250514"]],
		["claude-opus-4", ["anthropic", "claude-opus-4-20250514"]],
		["gemini-2.0-flash-001", ["google", "gemini-2.0-flash-001"]],
		["gpt-4.1", ["openai", "gpt-4.1"]],
		["gpt-4o", ["openai", "gpt-4o"]],
		["gpt-4o-mini", ["openai", "gpt-4o-mini"]],
		["o1-mini", ["openai", "o1-mini"]],
		["o3-mini", ["openai", "o3-mini"]],
		["o4-mini", ["openai", "o4-mini"]]
	];

	describe('findProviderByModel', () => {
		it('should correctly identify provider for each model', () => {
			modelMap.forEach(([modelName, [expectedProvider]]) => {
				expect(findProviderByModel(modelName)).toBe(expectedProvider);
			});
		});
	});

	describe('findModel', () => {
		it('should find model for each provider and model combination', () => {
			modelMap.forEach(([modelName, [expectedProvider, expectedModel]]) => {
				const model = findModel(expectedProvider, modelName);
				expect(model).toBeDefined();
				if (model) {
					expect(model.provider).toBe(expectedProvider);
					expect(model.name).toBe(expectedModel);
				}
			});
		});
	});
});
