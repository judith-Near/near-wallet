import * as nearApiJs from 'near-api-js'
import { store } from '..'
import { WalletError } from './walletError'
import { promptTwoFactor } from '../actions/account'
import { ACCESS_KEY_FUNDING_AMOUNT, convertPKForContract, toPK } from './wallet'

const { 
    Account,
    transactions: { deleteKey, addKey, functionCall, functionCallAccessKey, deployContract }
} = nearApiJs
export const METHOD_NAMES_LAK = ['add_request', 'add_request_and_confirm', 'delete_request', 'confirm']
const VIEW_METHODS = ['get_request_nonce', 'list_request_ids']
const METHOD_NAMES_CONFIRM = ['confirm']
const LAK_ALLOWANCE = process.env.LAK_ALLOWANCE || '10000000000000'
const actionTypes = {
    'functionCall': 'FunctionCall'
}

export class TwoFactor extends Account {
    constructor(wallet) {
        super(wallet.connection, wallet.accountId)
        console.log('twoFactor constructor', wallet.accountId)
        this.accountId = wallet.accountId
        this.wallet = wallet
    }

    getAccount() {
        let account = this
        if (this.wallet.recoveryAccount) {
            account = this.wallet.recoveryAccount
        }
        return account
    }

    async get2faMethod() {
        if (!this.wallet.has2fa) {
            return null
        }
        return (await this.wallet.getRecoveryMethods())
            .data.filter((m) => m.kind.indexOf('2fa-') > -1)
            .map(({ kind, detail, createdAt }) => ({ kind, detail, createdAt }))[0]
    }

    async initTwoFactor(accountId, method) {
        // clear any previous requests in localStorage (for verifyTwoFactor)
        setRequest({})
        return await this.wallet.postSignedJson('/2fa/init', {
            accountId,
            method
        });
    }

    async reInitTwoFactor(accountId, method) {
        // clear any previous requests in localStorage (for verifyTwoFactor)
        setRequest({})
        return this.sendRequest(accountId, method)
    }

    async resend(accountId, method) {
        if (!accountId) accountId = this.wallet.accountId
        if (!method) method = await this.get2faMethod()
        const requestData = getRequest()
        let { requestId } = requestData
        if (!requestId && requestId !== 0) {
            requestId = -1
        }
        return this.sendRequest(accountId, method, requestId)
    }

    // requestId is optional, if included the server will try to confirm requestId
    async verifyTwoFactor(accountId, securityCode) {
        const requestData = getRequest()
        let { requestId } = requestData
        if (!requestId && requestId !== 0) {
            requestId = -1
        }
        if (!accountId) accountId = this.getAccount().accountId
        return await this.wallet.postSignedJson('/2fa/verify', {
            accountId,
            securityCode,
            requestId
        });
    }

    async request(request) {
        const account = this.getAccount()
        const { accountId } = account
        const contract = getContract(account, accountId)
        await deleteUnconfirmedRequests(contract)
        const request_id = await contract.get_request_nonce()
        const res = await contract.add_request_and_confirm({ request })
        const request_id_after = await contract.get_request_nonce()
        if (request_id_after > request_id) {
            const method = await this.get2faMethod()
            return await this.sendRequest(accountId, method, request_id)
        }
    }

    async sendRequest(accountId, method, requestId = -1) {
        if (!accountId) accountId = this.wallet.accountId
        if (!method) method = await this.get2faMethod()
        // add request to local storage
        setRequest({ accountId, requestId })
        try {
            await this.wallet.postSignedJson('/2fa/send', {
                accountId,
                method,
                requestId,
            })
        } catch (e) {
            throw(e)
        }
        if (requestId !== -1) {
            const { verified, txResponse } = await store.dispatch(promptTwoFactor(true)).payload.promise
            if (!verified) {
                throw new WalletError('Request was cancelled.', 'errors.twoFactor.userCancelled')
            }
            return txResponse
        }
    }

    async deployMultisig() {
        const accountData = await this.wallet.loadAccount()
        const contractBytes = new Uint8Array(await (await fetch('/multisig.wasm')).arrayBuffer())
        const { accountId } = accountData
        const account = this.wallet.getAccount(accountId)
        const accountKeys = await account.getAccessKeys();
        const recoveryMethods = await this.wallet.getRecoveryMethods()
        const recoveryKeysED = recoveryMethods.data.map((rm) => rm.publicKey)
        const fak2lak = recoveryMethods.data.filter(({ kind, publicKey }) => kind !== 'phrase' && publicKey !== null).map((rm) => toPK(rm.publicKey))
        fak2lak.push(...accountKeys.filter((ak) => !recoveryKeysED.includes(ak.public_key)).map((ak) => toPK(ak.public_key)))
        const getPublicKey = await this.wallet.postSignedJson('/2fa/getAccessKey', { accountId })
        const confirmOnlyKey = toPK(getPublicKey.publicKey)
        const newArgs = new Uint8Array(new TextEncoder().encode(JSON.stringify({ 'num_confirmations': 2 })));
        const actions = [
            ...fak2lak.map((pk) => deleteKey(pk)),
            ...fak2lak.map((pk) => addKey(pk, functionCallAccessKey(accountId, METHOD_NAMES_LAK, null))),
            addKey(confirmOnlyKey, functionCallAccessKey(accountId, METHOD_NAMES_CONFIRM, null)),
            deployContract(contractBytes),
            functionCall('new', newArgs, LAK_ALLOWANCE, '0'),
        ]
        console.log('deploying multisig contract for', accountId)
        return await account.signAndSendTransaction(accountId, actions);
    }

    /********************************
    Account overrides
    ********************************/

    async sendMoney(receiver_id, amount) {
        const request = {
            receiver_id,
            actions: [{ type: 'Transfer', amount }]
        }
        return await this.request(request)
    }

    async addKey(publicKey, notFullAccess) {
        const fullAccess = notFullAccess === undefined
        const account = this.getAccount()
        const { accountId } = account
        const accessKeys = await this.getAccessKeys(accountId)
        if (accessKeys.find((ak) => ak.public_key.toString() === publicKey)) {
            // TODO check access key receiver_id matches contractId desired
            return true
        }
        publicKey = convertPKForContract(publicKey)
        const request = {
            receiver_id: account.accountId,
            actions: [addKeyAction(publicKey, accountId, fullAccess)]
        }
        return await this.request(request)
    }

    async deleteKey(publicKey) {
        const account = this.getAccount()
        const request = {
            receiver_id: account.accountId,
            actions: [deleteKeyAction(publicKey)]
        }
        return await this.request(request)
    }

    async rotateKeys(addPublicKey, removePublicKey) {
        const { accountId } = this.getAccount()
        const request = {
            receiver_id: accountId,
            actions: [
                addKeyAction(addPublicKey, accountId, false),
                deleteKeyAction(removePublicKey)
            ]
        }
        return await this.request(request)
    }

    async signAndSendTransactions(transactions) {
        for (let { receiverId, actions } of transactions) {
            actions = actions.map((a) => {
                const action = {
                    ...a[a.enum],
                    type: actionTypes[a.enum],
                }
                if (action.gas) action.gas = action.gas.toString()
                if (action.deposit) action.deposit = action.deposit.toString()
                if (action.args && Array.isArray(action.args)) action.args = Buffer.from(action.args).toString('base64')
                if (action.methodName) {
                    action.method_name = action.methodName
                    delete action.methodName
                }
                return action
            })
            await this.request({ receiver_id: receiverId, actions })
        }
    }
}

const getContract = (account) => {
    return new nearApiJs.Contract(account, account.accountId, {
        viewMethods: VIEW_METHODS,
        changeMethods: METHOD_NAMES_LAK,
    });
}

const deleteUnconfirmedRequests = async (contract) => {
    const request_ids = await contract.list_request_ids().catch((e) => { console.log(e) })
    if (!request_ids || request_ids.length === 0) {
        return
    }
    for (const request_id of request_ids) {
        try {
            await contract.delete_request({ request_id })
        } catch(e) {
            console.warn(e)
        }
    }
}

const getRequest = () => {
    return JSON.parse(localStorage.getItem(`__multisigRequest`) || `{}`)
}

const setRequest = (data) => {
    localStorage.setItem(`__multisigRequest`, JSON.stringify(data))
}

const addKeyAction = (publicKey, accountId, fullAccess) => {
    let allowance = ACCESS_KEY_FUNDING_AMOUNT
    let method_names = METHOD_NAMES_LAK
    return {
        type: 'AddKey',
        public_key: convertPKForContract(publicKey),
        ...(!fullAccess ? {
            permission: {
                receiver_id: accountId,
                allowance,
                method_names
            }
        } : null)
    }
}

const deleteKeyAction = (publicKey) => ({ type: 'DeleteKey', public_key: convertPKForContract(publicKey) })
