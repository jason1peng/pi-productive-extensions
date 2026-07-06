export const DELIVERY_PHASES = ["IMPLEMENT", "VERIFY", "REVIEW", "CLOSE", "RETRO"] as const;

export type DeliveryPhase = (typeof DELIVERY_PHASES)[number];
export type DeliveryProfileDefinition<T = unknown> = Record<DeliveryPhase, T>;
export type DeliveryProfileDefinitions<T = unknown> = Record<string, DeliveryProfileDefinition<T>>;
export type DeliveryProfileDefinitionSource = "global-phase-launches" | "built-in-phase-launches";
export type DeliveryProfileSelectionSource =
	| "env"
	| "global-active-profile"
	| "global-default-profile"
	| "global-first-profile"
	| "built-in-default-profile"
	| "built-in-first-profile";

export interface DeliveryProfileConfig<T = unknown> {
	defaultProfile?: string;
	profiles: string[];
	profileDefinitions: DeliveryProfileDefinitions<T>;
}

export interface DeliveryProfileSelection {
	activeProfile: string;
	activeSource: DeliveryProfileSelectionSource;
	envOverride: boolean;
	envProfile?: string;
	savedActiveProfile?: string;
}

export interface ActiveProfileFileOptions {
	missingProperty?: "undefined" | "error";
	label?: string;
}

export function isDeliveryPhase(value: string): value is DeliveryPhase {
	return (DELIVERY_PHASES as readonly string[]).includes(value);
}

export function profileConfigFromRaw<T = unknown>(raw: unknown, filePath: string): DeliveryProfileConfig<T> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Delivery profile config ${filePath} must be an object.`);
	const config = raw as { defaultProfile?: unknown; profiles?: unknown };
	if (config.defaultProfile !== undefined && (typeof config.defaultProfile !== "string" || !config.defaultProfile.trim())) {
		throw new Error(`Delivery profile config ${filePath} has invalid defaultProfile.`);
	}
	if (!config.profiles || typeof config.profiles !== "object" || Array.isArray(config.profiles)) {
		throw new Error(`Delivery profile config ${filePath} must define profiles.`);
	}
	const profileDefinitions: DeliveryProfileDefinitions<T> = {};
	const profiles = Object.entries(config.profiles as Record<string, unknown>).map(([name, value]) => {
		const profileName = name.trim();
		if (!profileName) throw new Error(`Delivery profile config ${filePath} has an empty profile name.`);
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Delivery profile config ${filePath} profile ${name} must be an object keyed by phase.`);
		const phaseConfig = value as Record<string, unknown>;
		for (const phase of Object.keys(phaseConfig)) {
			if (!isDeliveryPhase(phase)) throw new Error(`Delivery profile config ${filePath} profile ${name} has unknown phase: ${phase}`);
		}
		for (const phase of DELIVERY_PHASES) {
			if (!(phase in phaseConfig)) throw new Error(`Delivery profile config ${filePath} profile ${name} is missing required phase: ${phase}`);
		}
		profileDefinitions[profileName] = Object.fromEntries(DELIVERY_PHASES.map((phase) => [phase, phaseConfig[phase] as T])) as DeliveryProfileDefinition<T>;
		return profileName;
	});
	if (!profiles.length) throw new Error(`Delivery profile config ${filePath} must define at least one profile.`);
	const defaultProfile = config.defaultProfile?.trim();
	if (defaultProfile && !profiles.includes(defaultProfile)) throw new Error(`Delivery profile config ${filePath} defaultProfile=${defaultProfile} is not defined in profiles.`);
	return { ...(defaultProfile ? { defaultProfile } : {}), profiles, profileDefinitions };
}

export function readActiveProfilePayload(raw: unknown, filePath: string, options: ActiveProfileFileOptions = {}): string | undefined {
	const label = options.label ?? "Active profile config";
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${label} ${filePath} must be an object with activeProfile.`);
	const activeProfile = (raw as { activeProfile?: unknown }).activeProfile;
	if (activeProfile === undefined && options.missingProperty === "undefined") return undefined;
	if (typeof activeProfile !== "string" || !activeProfile.trim()) throw new Error(`${label} ${filePath} has invalid activeProfile.`);
	return activeProfile.trim();
}

export function activeProfileFilePayload(profileName: string): { activeProfile: string } {
	return { activeProfile: profileName };
}

export function selectDeliveryProfile(params: {
	profiles: string[];
	defaultProfile?: string;
	definitionSource: DeliveryProfileDefinitionSource;
	envProfile?: string;
	savedActiveProfile?: string;
}): DeliveryProfileSelection {
	const envProfile = params.envProfile?.trim() || undefined;
	const savedActiveProfile = params.savedActiveProfile?.trim() || undefined;
	const activeProfile = envProfile ?? savedActiveProfile ?? params.defaultProfile ?? params.profiles[0];
	if (!activeProfile || !params.profiles.includes(activeProfile)) {
		throw new Error(`Delivery profile ${activeProfile || "<none>"} is not defined in ${params.definitionSource}.`);
	}
	const activeSource: DeliveryProfileSelectionSource = envProfile
		? "env"
		: savedActiveProfile
			? "global-active-profile"
			: params.defaultProfile
				? params.definitionSource === "global-phase-launches" ? "global-default-profile" : "built-in-default-profile"
				: params.definitionSource === "global-phase-launches" ? "global-first-profile" : "built-in-first-profile";
	return {
		activeProfile,
		activeSource,
		envOverride: Boolean(envProfile),
		...(envProfile ? { envProfile } : {}),
		...(savedActiveProfile ? { savedActiveProfile } : {}),
	};
}
