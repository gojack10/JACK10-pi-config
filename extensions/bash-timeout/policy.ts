export const FOREGROUND_TIMEOUT_SECONDS = 120;

const description =
	"Every foreground command is automatically stopped after 120 seconds; the timeout cannot be configured. Use bash_bg for work that may need longer.";

export function enforceForegroundTimeout<
	T extends {
		description: string;
		parameters: { properties: Record<string, unknown>; [key: string]: unknown };
		promptGuidelines?: string[];
		execute: (...args: any[]) => any;
	},
>(bash: T): T {
	return {
		...bash,
		description: `${bash.description} ${description}`,
		parameters: {
			...bash.parameters,
			properties: { command: bash.parameters.properties.command },
			required: ["command"],
		},
		promptGuidelines: [
			...(bash.promptGuidelines ?? []),
			"Every foreground bash command has an automatic hard 120-second timeout. Never supply or emulate a timeout.",
			"Use bash only for commands expected to finish within 120 seconds. If one may need longer, or a foreground command times out, launch it once with bash_bg instead.",
			"After bash_bg, do independent work or end the turn; never poll. Its automatic notification resumes you, and the completed log is the evidence to inspect.",
		],
		execute(toolCallId, { command }: { command: string }, ...rest) {
			return bash.execute(toolCallId, { command, timeout: FOREGROUND_TIMEOUT_SECONDS }, ...rest);
		},
	} as T;
}
