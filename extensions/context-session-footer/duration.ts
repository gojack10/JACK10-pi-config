export const formatFooterDuration = (milliseconds: number): string => {
	const total = Math.max(0, Math.ceil(milliseconds / 1000));
	const days = Math.floor(total / 86_400);
	const hours = Math.floor((total % 86_400) / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	const clock = [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
	return days > 0 ? `${days}D ${clock}` : clock;
};

// Countdown for reset events: ##D##H##M##S with colons, zero units dropped
// anywhere in the chain, no zero padding, bare 0S when nothing remains.
export const formatFooterCountdown = (milliseconds: number): string => {
	const total = Math.max(0, Math.ceil(milliseconds / 1000));
	const days = Math.floor(total / 86_400);
	const hours = Math.floor((total % 86_400) / 3_600);
	const minutes = Math.floor((total % 3_600) / 60);
	const seconds = total % 60;
	const parts = [
		...(days > 0 ? [`${days}D`] : []),
		...(hours > 0 ? [`${hours}H`] : []),
		...(minutes > 0 ? [`${minutes}M`] : []),
		...(seconds > 0 ? [`${seconds}S`] : []),
	];
	return parts.length > 0 ? parts.join(":") : "0S";
};
