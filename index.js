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
                    if (typeof this.config.url === 'string') {
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
                        for (const context of contexts) {
                            if (context.contextProfile?.type !== 'Application') continue;
                            const app = apps.find(item => item.name === context.contextName);
                            const uri = app ? `/v1/Applications/${app.application_sid}` : '/v1/Applications';
                            const props = {
                                call_hook: webhook(context.appId, 'dialogflow', context.clientId),
                                call_status_hook: webhook(context.appId, 'status', context.clientId),
                                messaging_hook: webhook(context.appId, 'message', context.clientId),
                                speech_synthesis_vendor: 'google',
                                speech_synthesis_language: 'bg-BG',
                                speech_synthesis_voice: 'bg-bg-Standard-A',
                                speech_recognizer_vendor: 'google',
                                speech_recognizer_language: 'bg-BG'
                            };
                            const appResult = (!app || !matches(props)(app)) && await this.sendRequest({
                                uri,
                                method: app ? 'PUT' : 'POST',
                                headers: {
                                    authorization: `Bearer ${context.verifyToken}`
                                },
                                body: {
                                    name: context.contextName,
                                    account_sid: context.appId,
                                    ...props
                                }
                            });
                            // update Device calling application
                            for (const accountId of accountIds) {
                                const inbound = contexts.find(item => item.appId === accountId)?.botProfile?.inbound;
                                if (inbound && inbound === context.clientId) {
                                    accountsUpdate[accountId].device_calling_application_sid = app ? app.application_sid : appResult.sid;
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
                            for (const context of contexts) {
                                const profile = context.contextProfile;
                                const vendor = profile?.speechVendor;
                                if (!['google'].includes(vendor)) continue;
                                const speech = speechCredentials.find(item => item.account_sid === context.appId && item.vendor === vendor);
                                const props = {
                                    type: profile.type || 'service_account',
                                    auth_uri: profile.auth_uri || 'https://accounts.google.com/o/oauth2/auth',
                                    token_uri: profile.token_uri || 'https://oauth2.googleapis.com/token',
                                    auth_provider_x509_cert_url: profile.auth_provider_x509_cert_url || 'https://www.googleapis.com/oauth2/v1/certs',
                                    project_id: profile.project_id,
                                    private_key_id: profile.private_key_id,
                                    private_key: context.accessToken,
                                    client_email: context.clientId,
                                    client_id: profile.client_id,
                                    client_x509_cert_url: profile.client_x509_cert_url
                                };
                                if (!speech || !matches(props)(JSON.parse(speech.service_key))) {
                                    if (speech) {
                                        await this.sendRequest({
                                            uri: `/v1/Accounts/${speech.account_sid}/SpeechCredentials/${speech.speech_credential_sid}`,
                                            method: 'DELETE',
                                            headers: {
                                                authorization: authorization(speech.account_sid)
                                            }
                                        });
                                    };
                                    await this.sendRequest({
                                        uri: `/v1/Accounts/${speech.account_sid}/SpeechCredentials`,
                                        method: 'POST',
                                        headers: {
                                            authorization: authorization(speech.account_sid)
                                        },
                                        body: {
                                            vendor,
                                            service_key: JSON.stringify(props),
                                            use_for_tts: true,
                                            use_for_stt: true
                                        }
                                    });
                                }
                            }
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
