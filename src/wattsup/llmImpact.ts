// EcoLogits TypeScript implementation
// Provides the same llmImpact function as ecologits for python

import electricityMixes from './data/electricity_mixes.json';
import models from './data/models.json';

interface RangeValue { min: number; max: number }

function isRange(v: unknown): v is RangeValue {
	return typeof v === 'object' && v !== null && 'min' in v && 'max' in v;
}

function toRange(v: number | RangeValue): RangeValue {
	if (isRange(v)) return v;
	return { min: v, max: v };
}

function addRange(a: number | RangeValue, b: number | RangeValue): RangeValue {
	const ra = toRange(a);
	const rb = toRange(b);
	return { min: ra.min + rb.min, max: ra.max + rb.max };
}

function mulRange(a: number | RangeValue, scalar: number): RangeValue {
	const ra = toRange(a);
	return { min: ra.min * scalar, max: ra.max * scalar };
}

function ltRange(a: number | RangeValue, b: number): boolean {
	const ra = toRange(a);
	return ra.max < b;
}

function findModel(provider: string, name: string) {
	const alias = (models.aliases || []).find((a: any) => a.provider === provider && a.name === name);
	if (alias) name = alias.alias;
	return (models.models || []).find((m: any) => m.provider === provider && m.name === name);
}

function findMix(zone: string) {
	return electricityMixes[zone as keyof typeof electricityMixes];
}

const MODEL_QUANTIZATION_BITS = 4;
const GPU_ENERGY_ALPHA = 8.91e-8;
const GPU_ENERGY_BETA = 1.43e-6;
const GPU_ENERGY_STDEV = 5.19e-7;
const GPU_LATENCY_ALPHA = 8.02e-4;
const GPU_LATENCY_BETA = 2.23e-2;
const GPU_LATENCY_STDEV = 7.00e-6;
const GPU_MEMORY = 80; // GB
const GPU_EMBODIED_IMPACT_GWP = 143;
const GPU_EMBODIED_IMPACT_ADPE = 5.1e-3;
const GPU_EMBODIED_IMPACT_PE = 1828;
const SERVER_GPUS = 8;
const SERVER_POWER = 1; // kW
const SERVER_EMBODIED_IMPACT_GWP = 3000;
const SERVER_EMBODIED_IMPACT_ADPE = 0.24;
const SERVER_EMBODIED_IMPACT_PE = 38000;
const HARDWARE_LIFESPAN = 5 * 365 * 24 * 60 * 60;
const DATACENTER_PUE = 1.2;

function computeImpactsOnce(opts: { activeParams: number; totalParams: number; outputTokens: number; requestLatency: number; mix: any }): Record<string, RangeValue> {
	const { activeParams, totalParams, outputTokens, requestLatency, mix } = opts;
	const energyPerToken = GPU_ENERGY_ALPHA * activeParams + GPU_ENERGY_BETA;
	const gpuEnergy: RangeValue = {
		min: Math.max(0, outputTokens * (energyPerToken - 1.96 * GPU_ENERGY_STDEV)),
		max: outputTokens * (energyPerToken + 1.96 * GPU_ENERGY_STDEV)
	};

	const latencyPerToken = GPU_LATENCY_ALPHA * activeParams + GPU_LATENCY_BETA;
	const latencyInterval: RangeValue = {
		min: Math.max(0, outputTokens * (latencyPerToken - 1.96 * GPU_LATENCY_STDEV)),
		max: outputTokens * (latencyPerToken + 1.96 * GPU_LATENCY_STDEV)
	};
	const generationLatency = ltRange(latencyInterval, requestLatency) ? latencyInterval : requestLatency;
	const genLatRange = toRange(generationLatency);

	const modelMemory = 1.2 * totalParams * MODEL_QUANTIZATION_BITS / 8;
	const gpuCount = Math.ceil(modelMemory / GPU_MEMORY);

	const serverEnergy = mulRange(genLatRange, SERVER_POWER / 3600 * (gpuCount / SERVER_GPUS));
	const requestEnergy = mulRange(addRange(serverEnergy, mulRange(gpuEnergy, gpuCount)), DATACENTER_PUE);

	const usageGWP = mulRange(requestEnergy, mix.gwp);
	const usageADPe = mulRange(requestEnergy, mix.adpe);
	const usagePE = mulRange(requestEnergy, mix.pe);

	const serverGpuEmbodiedGWP = (gpuCount / SERVER_GPUS) * SERVER_EMBODIED_IMPACT_GWP + gpuCount * GPU_EMBODIED_IMPACT_GWP;
	const serverGpuEmbodiedADPe = (gpuCount / SERVER_GPUS) * SERVER_EMBODIED_IMPACT_ADPE + gpuCount * GPU_EMBODIED_IMPACT_ADPE;
	const serverGpuEmbodiedPE = (gpuCount / SERVER_GPUS) * SERVER_EMBODIED_IMPACT_PE + gpuCount * GPU_EMBODIED_IMPACT_PE;

	const embodiedGWP = mulRange(genLatRange, serverGpuEmbodiedGWP / HARDWARE_LIFESPAN);
	const embodiedADPe = mulRange(genLatRange, serverGpuEmbodiedADPe / HARDWARE_LIFESPAN);
	const embodiedPE = mulRange(genLatRange, serverGpuEmbodiedPE / HARDWARE_LIFESPAN);

	return {
		request_energy: requestEnergy,
		request_usage_gwp: usageGWP,
		request_usage_adpe: usageADPe,
		request_usage_pe: usagePE,
		request_embodied_gwp: embodiedGWP,
		request_embodied_adpe: embodiedADPe,
		request_embodied_pe: embodiedPE,
	};
}

function mergeRanges(a: RangeValue | number, b: RangeValue | number): RangeValue {
	const ra = toRange(a);
	const rb = toRange(b);
	return { min: Math.min(ra.min, rb.min), max: Math.max(ra.max, rb.max) };
}

function computeLLMImpacts(opts: { activeParams: number | RangeValue; totalParams: number | RangeValue; outputTokens: number; requestLatency: number; mix: any }) {
	const { activeParams, totalParams, outputTokens, requestLatency, mix } = opts;
	const activeVals = isRange(activeParams) ? [activeParams.min, activeParams.max] : [activeParams, activeParams];
	const totalVals = isRange(totalParams) ? [totalParams.min, totalParams.max] : [totalParams, totalParams];

	const fields = [
		'request_energy',
		'request_usage_gwp',
		'request_usage_adpe',
		'request_usage_pe',
		'request_embodied_gwp',
		'request_embodied_adpe',
		'request_embodied_pe'
	];
	const results: Record<string, RangeValue> = {};
	for (let i = 0; i < activeVals.length; i++) {
		const res = computeImpactsOnce({
			activeParams: activeVals[i],
			totalParams: totalVals[i],
			outputTokens,
			requestLatency,
			mix
		});
		for (const f of fields) {
			if (!results[f]) {
				results[f] = res[f];
			} else {
				results[f] = mergeRanges(results[f], res[f]);
			}
		}
	}

	const energy = results.request_energy;
	const gwpUsage = results.request_usage_gwp;
	const adpeUsage = results.request_usage_adpe;
	const peUsage = results.request_usage_pe;
	const gwpEmbodied = results.request_embodied_gwp;
	const adpeEmbodied = results.request_embodied_adpe;
	const peEmbodied = results.request_embodied_pe;

	return {
		energy,
		gwp: addRange(gwpUsage, gwpEmbodied),
		adpe: addRange(adpeUsage, adpeEmbodied),
		pe: addRange(peUsage, peEmbodied),
		usage: {
			energy,
			gwp: gwpUsage,
			adpe: adpeUsage,
			pe: peUsage
		},
		embodied: {
			gwp: gwpEmbodied,
			adpe: adpeEmbodied,
			pe: peEmbodied
		}
	};
}

type Impact = ReturnType<typeof computeLLMImpacts>;

export default function llmImpact(provider: string, modelName: string, outputTokenCount: number, requestLatency: number, electricityMixZone: string = 'WOR'): Impact {
	const model = findModel(provider, modelName);
	if (!model) {
		throw new Error(`Could not find model \`${modelName}\` for ${provider} provider.`);
	}
	const mix = findMix(electricityMixZone);
	if (!mix) {
		throw new Error(`Could not find electricity mix for zone \`${electricityMixZone}\`.`);
	}

	let totalParams: number | RangeValue;
	let activeParams: number | RangeValue;
	if (model.architecture.type === 'moe') {
		totalParams = (model.architecture.parameters as any).total;
		activeParams = (model.architecture.parameters as any).active;
	} else {
		totalParams = model.architecture.parameters as number;
		activeParams = model.architecture.parameters as number;
	}

	return computeLLMImpacts({
		activeParams,
		totalParams,
		outputTokens: outputTokenCount,
		requestLatency,
		mix
	});
}