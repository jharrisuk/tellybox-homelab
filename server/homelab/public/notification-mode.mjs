export function notificationMode(services) {
	return services.firebase?.enabled?'custom':services.pushGateway?.enabled?'standard':'off';
}

export function withNotificationMode(services,mode) {
	if(!['off','standard','custom'].includes(mode))throw Error('Choose a notification provider.');
	return {...services,pushGateway:{...services.pushGateway,enabled:mode==='standard'},firebase:{...services.firebase,enabled:mode==='custom'}};
}
