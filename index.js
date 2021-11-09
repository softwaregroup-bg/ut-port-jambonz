const crypto = require('crypto');

const sendMessage = (msg, {auth}) => {
    return msg;
};

function parseHeader(header, scheme) {
    if (typeof header !== 'string') return null;
    return header.split(',').reduce(
        (accum, item) => {
            const kv = item.split('=');

            if (kv[0] === 't') {
                accum.timestamp = kv[1];
            }

            if (kv[0] === scheme) {
                accum.signatures.push(kv[1]);
            }

            return accum;
        },
        {
            timestamp: -1,
            signatures: []
        }
    );
}

module.exports = function jambonz({utMethod}) {
    return class jambonz extends require('ut-port-webhook')(...arguments) {
        get defaults() {
            return {
                path: '/jambonz/{appId}/{clientId}/{hook}',
                hook: 'jambonzIn',
                namespace: 'jambonz',
                mode: 'reply',
                async: 'client',
                server: {
                    port: 8086
                },
                request: {
                    baseUrl: 'https://jambonz.us/'
                }
            };
        }

        handlers() {
            const {namespace, hook} = this.config;
            return {
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
