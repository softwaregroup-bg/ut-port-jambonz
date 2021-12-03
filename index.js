const crypto = require('crypto');
const matches = require('lodash.matches');

const sendMessage = (msg, {auth}) => {
    return msg;
};

function parseHeader(header, scheme) {
    if (typeof header !== 'string') return null;
    return header.split(',').reduce(
        (result, item) => {
            const kv = item.split('=');
            if (kv[0] === 't') result.timestamp = kv[1];
            if (kv[0] === scheme) result.signatures.push(kv[1]);
            return result;
        },
        {
            timestamp: -1,
            signatures: []
        }
    );
}

module.exports = function jambonz({utMethod, utMeta}) {
    return class jambonz extends require('ut-port-webhook')(...arguments) {
        get defaults() {
            return {
                path: '/jambonz/{appId}/{hook}/{clientId?}',
                hook: 'jambonzIn',
                namespace: 'jambonz',
                mode: 'reply',
                async: 'client',
                log: {
                    transform: {
                        webhook_secret: 'hide',
                        service_key: 'hide'
                    }
                },
                server: {
                    port: 8086
                },
                request: {
                    baseUrl: 'https://api.jambonz.us'
                }
            };
        }

        handlers() {
            const {namespace, hook} = this.config;
            const webhook = (appId, hook, clientId) => ({
                method: 'POST',
                url: `${this.config.url}${this.config.path.replace('{appId}', appId).replace('{hook}', hook).replace('/{clientId?}', clientId ? `/${clientId}` : '')}`
            });
            return {
                async ready() {
                    if (typeof this.config.url !== 'string') return;

                    const contexts = await utMethod('bot.botContext.fetch#[]')({platform: 'jambonz'}, utMeta());
                    const authorization = appId => `Bearer ${contexts.find(item => item.appId === appId).verifyToken}`;
                    const accountIds = Array.from(new Set(contexts.map(({appId}) => appId)));
                    const accountsUpdate = Object.fromEntries(accountIds.map(accountId => [accountId, {
                        registration_hook: webhook(accountId, 'register')
                    }]));
                    const accounts = (await Promise.all(accountIds.map(accountId => this.sendRequest({
                        uri: '/v1/Accounts',
                        method: 'GET',
                        headers: {
                            authorization: authorization(accountId)
                        }
                    })))).flat();
                    const apps = (await Promise.all(accountIds.map(accountId => this.sendRequest({
                        uri: '/v1/Applications',
                        method: 'GET',
                        headers: {
                            authorization: authorization(accountId)
                        }
                    })))).flat();
                    const speechCredentials = (await Promise.all(accountIds.map(accountId => this.sendRequest({
                        uri: `/v1/Accounts/${accountId}/SpeechCredentials`,
                        method: 'GET',
                        headers: {
                            authorization: authorization(accountId)
                        }
                    })))).flat();
                    for (const context of contexts.filter(({contextProfile}) => contextProfile?.type === 'Application')) {
                        const {appId, clientId, contextProfile, botProfile} = context;
                        const app = apps.find(item => item.name === context.contextName);
                        const uri = app ? `/v1/Applications/${app.application_sid}` : '/v1/Applications';
                        const props = {
                            call_hook: webhook(appId, 'dialogflow', clientId),
                            call_status_hook: webhook(appId, 'status', clientId),
                            messaging_hook: webhook(appId, 'message', clientId),
                            speech_synthesis_vendor: contextProfile.speechVendor,
                            speech_synthesis_language: contextProfile.speechLanguage,
                            speech_synthesis_voice: contextProfile.speechVoice,
                            speech_recognizer_vendor: contextProfile.speechVendor,
                            speech_recognizer_language: contextProfile.speechLanguage
                        };
                        const appResult = (!app || !matches(props)(app)) && await this.sendRequest({
                            uri,
                            method: app ? 'PUT' : 'POST',
                            headers: {
                                authorization: `Bearer ${context.verifyToken}`
                            },
                            body: {
                                name: context.contextName,
                                account_sid: appId,
                                ...props
                            }
                        });
                        // set Device calling application
                        if (clientId === botProfile?.inbound) {
                            accountsUpdate[appId].device_calling_application_sid = app ? app.application_sid : appResult.sid;
                        }
                    }
                    // update accounts
                    for (const [accountId, body] of Object.entries(accountsUpdate)) {
                        const account = accounts.find(item => item.account_sid === accountId);
                        account && !matches(body)(account) && await this.sendRequest({
                            uri: `/v1/Accounts/${accountId}`,
                            method: 'PUT',
                            headers: {
                                authorization: authorization(accountId)
                            },
                            body
                        });
                    }
                    // update speech credentials
                    for (const context of contexts.filter(({contextProfile}) => contextProfile.speechVendor && contextProfile?.type !== 'Application')) {
                        const {appId, clientId, accessToken, contextProfile} = context;
                        const vendor = contextProfile?.speechVendor;
                        const speech = speechCredentials.find(item => item.account_sid === context.appId && item.vendor === vendor);
                        let credentials;
                        let match = false;
                        switch (vendor) {
                            case 'google':
                                credentials = {
                                    type: contextProfile.type || 'service_account',
                                    auth_uri: contextProfile.auth_uri || 'https://accounts.google.com/o/oauth2/auth',
                                    token_uri: contextProfile.token_uri || 'https://oauth2.googleapis.com/token',
                                    auth_provider_x509_cert_url: contextProfile.auth_provider_x509_cert_url || 'https://www.googleapis.com/oauth2/v1/certs',
                                    project_id: contextProfile.project_id,
                                    private_key_id: contextProfile.private_key_id,
                                    private_key: accessToken,
                                    client_email: clientId,
                                    client_id: contextProfile.client_id,
                                    client_x509_cert_url: contextProfile.client_x509_cert_url
                                };
                                match = matches(credentials)(JSON.parse(speech.service_key));
                                credentials = {service_key: JSON.stringify(credentials)};
                                break;
                            case 'microsoft':
                                credentials = {
                                    api_key: contextProfile.accessToken,
                                    region: contextProfile.region
                                };
                                // TBD: fetching speech services does not return api_key for microsoft vendor
                                break;
                            default: continue;
                        }
                        if (!speech || !match) {
                            if (speech) {
                                await this.sendRequest({
                                    uri: `/v1/Accounts/${appId}/SpeechCredentials/${speech.speech_credential_sid}`,
                                    method: 'DELETE',
                                    headers: {
                                        authorization: authorization(appId)
                                    }
                                });
                            };
                            await this.sendRequest({
                                uri: `/v1/Accounts/${appId}/SpeechCredentials`,
                                method: 'POST',
                                headers: {
                                    authorization: authorization(appId)
                                },
                                body: {
                                    vendor,
                                    ...credentials,
                                    use_for_tts: true,
                                    use_for_stt: true
                                }
                            });
                        }
                    }
                },
                [`${hook}.identity.request.receive`]: (msg, {params, request: {headers}}) => {
                    if (typeof headers['jambonz-signature'] !== 'string') {
                        throw this.errors['webhook.missingHeader']({params: {header: 'jambonz-signature'}});
                    }
                    return {
                        clientId: params.clientId,
                        appId: params.appId,
                        platform: 'jambonz'
                    };
                },
                [`${hook}.identity.response.send`]: async(msg, {request: {headers, payload}}) => {
                    const header = parseHeader(headers['jambonz-signature'], 'v1');
                    const serverSignature = header?.signatures && crypto
                        .createHmac('sha256', msg.secret)
                        .update(`${header.timestamp}.${payload.toString('utf8')}`, 'utf8')
                        .digest();
                    if (header?.signatures.some(signature => {
                        const buf = Buffer.from(signature, 'hex');
                        return buf.length === serverSignature.length && crypto.timingSafeEqual(buf, serverSignature);
                    })) {
                        return msg;
                    }
                    throw this.errors['webhook.integrityValidationFailed']();
                },
                [`${hook}.message.request.receive`]: (msg, $meta) => {
                    return {
                        messageId: msg.call_sid,
                        timestamp: msg.timestamp,
                        sender: {
                            id: msg?.sip?.headers?.from,
                            platform: 'jambonz',
                            conversationId: msg.call_id,
                            contextId: $meta.auth.contextId
                        },
                        receiver: {
                            id: $meta.params && $meta.params.clientId,
                            conversationId: msg.call_id
                        },
                        request: msg
                    };
                },
                [`${namespace}.message.send.request.send`]: sendMessage,
                [`${hook}.message.response.send`]: sendMessage
            };
        }
    };
};
