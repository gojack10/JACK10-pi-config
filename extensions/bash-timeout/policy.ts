export const FOREGROUND_TIMEOUT_SECONDS = 120;

const description =
	`Every foreground command is automatically stopped after ${FOREGROUND_TIMEOUT_SECONDS} seconds. This limit cannot be configured. Use bash_bg for commands that may take longer.`;

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
		description: `${bash.description.replace(" Optionally provide a timeout in seconds.", "")}\n\n${description}`,
		parameters: {
			...bash.parameters,
			properties: { command: bash.parameters.properties.command },
			required: ["command"],
		},
		promptGuidelines: [
			...(bash.promptGuidelines ?? []),
			`Every foreground bash command has an automatic hard ${FOREGROUND_TIMEOUT_SECONDS}-second timeout. Never supply or emulate a timeout.`,
			`Use bash only for commands expected to finish within ${FOREGROUND_TIMEOUT_SECONDS} seconds. If one may need longer, or a foreground command times out, launch it once with bash_bg instead.`,
			"After bash_bg, do independent work or end your turn without polling until the automatic notification resumes you to read the completed log.",
		],
		async execute(toolCallId, { command }: { command: string }, ...rest) {
			try {
				return await bash.execute(toolCallId, { command, timeout: FOREGROUND_TIMEOUT_SECONDS }, ...rest);
			} catch (error) {
				if (error instanceof Error && error.message.endsWith(`Command timed out after ${FOREGROUND_TIMEOUT_SECONDS} seconds`)) {
					error.message += `\n\nRun this command once with bash_bg because it exceeded bash's ${FOREGROUND_TIMEOUT_SECONDS}-second limit. After starting it, do independent work or end your turn until its completion notification arrives. Do not poll.`;
				}
				throw error;
			}
		},
	} as T;
}
