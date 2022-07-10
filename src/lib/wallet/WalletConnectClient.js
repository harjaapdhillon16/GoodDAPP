//@flow
import { useCallback, useEffect, useState } from 'react'
import WalletConnect from '@walletconnect/client'
import web3Utils from 'web3-utils'
import abiDecoder from 'abi-decoder'
import Web3 from 'web3'
import { first, sortBy } from 'lodash'
import AsyncStorage from '../utils/asyncStorage'
import { delay } from '../utils/async'
import api from '../../lib/API/api'
import logger from '../logger/js-logger'
import { useSessionApproveModal } from '../../components/walletconnect/WalletConnectModals'
import { useWallet } from './GoodWalletProvider'
const log = logger.child({ from: 'WalletConnectClient' })

//TODO:
//7. cancel tx
//8. edit gas
//9. advanced edit tx values/contract call values
//10. events

/**
 * Parses the read WalletConnet URI from QR Code.
 * If not valid, returns null.
 * If valid, returns the WalletConnet URI.
 * @param {string} link - receive WalletConnect URI
 * @returns {string|null} - {link|null}
 */
export const readWalletConnectUri = link => {
  // checks that the link has the expected strings in it
  const eip1328UriFormat = /wc:[\w\d-]+@\d+\?bridge=.*&key=[a-z0-9]+/
  const validUri = link.match(eip1328UriFormat)[0]

  if (!validUri) {
    return null
  }

  return link
}

export const getWalletConnectTopic = link => {
  const eip1328UriFormat = /wc:([\w\d-]+)@\d+\?bridge=.*&key=[a-z0-9]+/
  const topic = link.match(eip1328UriFormat)[1]
  return topic
}

let chainsCache = []
export const useChainsList = () => {
  const [chains, setChains] = useState(chainsCache)
  chainsCache = chains
  useEffect(() => {
    if (chainsCache.length) {
      return
    }
    api.getChains().then(data => setChains(sortBy(data, 'name')))
  }, [setChains])
  return chains
}

const cachedWeb3 = {}
const getWeb3 = rpc => {
  const web3 = cachedWeb3[rpc]
  if (web3) {
    return web3
  }

  const tempWeb3 = new Web3(new Web3.providers.HttpProvider(rpc))

  cachedWeb3[rpc] = tempWeb3
  return tempWeb3
}

// Create connector
let cachedConnector
export const useWalletConnectSession = () => {
  const [activeConnector, setConnector] = useState()
  const [chain, setChain] = useState()
  const [pendingTxs, setPending] = useState([])

  const wallet = useWallet()
  const { show: showApprove } = useSessionApproveModal()
  const chains = useChainsList()

  const decodeTx = useCallback(
    async (connector, tx, explorer, web3) => {
      log.info('decodedTx:', { tx, chain, connector })
      if (tx.data && explorer) {
        log.info('fetching contract data', { chain, explorer, contract: tx.to })
        const { result } = await api.getContractAbi(explorer, tx.to)
        log.info('got contract data', { result })
        if (!result) {
          return
        }
        const abi = JSON.parse(result)
        abiDecoder.addABI(abi)
        const decoded = abiDecoder.decodeMethod(tx.data)
        log.info('decoded:', { decoded })
        const callData = await wallet.validateContractTX(abi, tx, decoded, web3)
        log.info('validateCall', { callData })
        return { ...callData, decoded }
      }
    },
    [chain, wallet],
  )

  const handleSessionRequest = useCallback(
    connector => {
      const session = connector.session
      log.info('approving session:', { session })
      showApprove({
        walletAddress: wallet.account,
        session,
        modalType: 'connect',
        onApprove: () => {
          connector.approveSession({ chainId: 1, accounts: [wallet.account] })
        },
        onReject: () => connector.rejectSession({ message: 'USER_DECLINE' }),
      })
    },
    [showApprove, wallet],
  )

  const handleSignRequest = useCallback(
    (message, payload, connector) => {
      log.info('handleSignRequest', { message, payload, session: connector.session })
      showApprove({
        walletAddress: wallet.account,
        session: connector.session,
        message,
        payload,
        modalType: 'sign',
        onApprove: async () => {
          try {
            let result
            if (payload.method === 'eth_sign') {
              result = await wallet.sign(message)
            }

            if (payload.method === 'personal_sign') {
              result = await wallet.personalSign(message)
            }

            if (payload.method.includes('signTypedData')) {
              result = await wallet.signTypedData(message)
            }

            log.info('sign request approved:', { result })
            connector.approveRequest({ id: payload.id, result })
          } catch (e) {
            connector.rejectRequest({ error: e.message, id: payload.id })
            throw e
          }
        },
        onReject: () => connector.rejectRequest({ id: payload.id, error: 'USER_DECLINE' }),
      })
    },
    [wallet, showApprove],
  )

  const handleTxRequest = useCallback(
    async (message, payload, connector) => {
      log.info('handleTxRequest', { message, payload, connector })
      const web3 = getWeb3(first(chain.rpc || chain.rpcUrls))

      let explorer
      if (chain.chainId === 122) {
        explorer = 'https://explorer.fuse.io'
      } else {
        explorer = first(chain.explorerUrls)
      }
      const [decodedTx, balance] = await Promise.all([
        decodeTx(connector, message, explorer, web3),
        web3.eth.getBalance(wallet.account),
      ])
      const gasRequired = Number(message.gas) * Number(message.gasPrice)
      const gasStatus = { balance, hasEnoughGas: balance >= gasRequired, gasRequired }
      showApprove({
        walletAddress: wallet.account,
        session: connector.session,
        message: { ...message, decodedTx, gasStatus },
        payload,
        modalType: 'tx',
        explorer,
        onApprove: async () => {
          try {
            if (payload.method === 'eth_signTransaction') {
              const result = await wallet.signTransaction(message)
              log.info('tx sign success:', { result })
              connector.approveRequest({ id: payload.id, result })
            }

            if (payload.method === 'eth_sendTransaction') {
              const txPromisEvent = wallet.sendRawTransaction(message, web3)
              txPromisEvent.on('transactionHash', result => {
                log.info('tx send success:', { result })
                connector.approveRequest({ id: payload.id, result })
                AsyncStorage.setItem(`GD_WALLETCONNECT_PENDING_${result}`, { txHash: result, payload })
              })
              txPromisEvent.on('receipt', result => {
                log.info('tx receipt:', { result })
                AsyncStorage.removeItem(`GD_WALLETCONNECT_PENDING_${result.transactionHash}`)
              })
            }
          } catch (e) {
            connector.rejectRequest({ error: e.message, id: payload.id })
            throw e
          }
        },
        onReject: () => connector.rejectRequest({ id: payload.id, error: 'USER_DECLINE' }),
      })
    },
    [wallet, chain, showApprove, decodeTx],
  )

  const handleScanRequest = useCallback(
    (payload, connector) => {
      log.info('handleScanRequest', { payload })
      showApprove({
        walletAddress: wallet.account,
        session: connector.session,
        modalType: 'scan',
        onApprove: data => {
          let result = data
          if (payload?.params?.[0]) {
            const regex = new RegExp(payload?.params?.[0])
            result = first(regex.exec(data))
          }
          log.debug('scan result:', { result, data, payload })
          if (result) {
            connector.approveRequest({ id: payload.id, result })
            return true
          }
          connector.rejectSession({ id: payload.id, message: 'NO_REGEX_MATCH', result })
          return false
        },
        onReject: () => connector.rejectRequest({ id: payload.id, error: 'USER_DECLINE' }),
      })
    },
    [showApprove],
  )

  const switchChain = useCallback(
    async chain => {
      log.debug('switching chain...', { chain })
      await activeConnector.updateSession({
        chainId: Number(chain.chainId),
        accounts: [wallet.account],
        rpcUrl: first(chain.rpcUrls || chain.rpc),
      })

      setChain(chain)
    },
    [activeConnector, wallet],
  )

  const handleSwitchChainRequest = useCallback(
    (payload, connector) => {
      log.info('handleSwitchChainRequest', { payload })
      const chain = payload.params
      const chainDetails = chains.find(_ => Number(_.chainId) === Number(chain.chainId))
      showApprove({
        walletAddress: wallet.account,
        session: connector.session,
        modalType: 'switchchain',
        message: `${chain.name || chainDetails.name || chain.chainId}: ${first(chain.rpcUrls || chain.rpc)}`,
        onApprove: () => {
          switchChain(chain)
        },
        onReject: () => connector.rejectRequest({ id: payload.id, error: 'USER_DECLINE' }),
      })
    },
    [showApprove],
  )

  const handleSessionDisconnect = useCallback(
    async connector => {
      const session = connector?.session
      log.info('ending session:', { session })
      connector?.killSession({ message: 'USER_TERMINATED' }).catch()
      setConnector(undefined)
      AsyncStorage.setItem('walletconnect', undefined)
      await delay(500)
    },
    [setConnector],
  )

  const handleUnsupportedRequest = useCallback(
    (payload, connector) => {
      const session = connector.session
      showApprove({
        walletAddress: wallet.account,
        payload,
        session,
        modalType: 'error',
      })
      connector.rejectRequest({ error: 'METHOD_NOT_SUPPORTED', id: payload.id })
    },
    [wallet],
  )

  const connect = useCallback(
    uriOrSession => {
      if (wallet) {
        const session = typeof uriOrSession === 'string' ? undefined : uriOrSession
        const uri = typeof uriOrSession === 'string' ? uriOrSession : undefined
        log.debug('got uri:', { uri, session, wallet })

        let connector = new WalletConnect({
          // Required
          uri,
          session,

          // Required
          clientMeta: {
            description: 'GoodDollar Wallet App',
            url: 'https://wallet.gooddollar.org.org',
            icons: [
              'https://wallet.gooddollar.org/favicon-96x96.png',
              'https://wallet.gooddollar.org/favicon-32x32.png',
              'https://wallet.gooddollar.org/favicon.ico',
            ],
            name: 'GoodDollar',
          },
        })
        log.debug('got uri created connection:', { uri, session, wallet, connector })

        if (connector.pending && !connector.connected) {
          handleSessionRequest(connector)
        }

        setConnector(connector)

        return connector
      }
    },
    [
      wallet,
      activeConnector,
      handleSessionDisconnect,
      handleSessionRequest,
      handleSignRequest,
      handleTxRequest,
      handleSwitchChainRequest,
      handleUnsupportedRequest,
      handleScanRequest,
    ],
  )

  useEffect(() => {
    if (!activeConnector) {
      return
    }
    const connector = activeConnector

    // Subscribe to session requests
    connector.on('session_request', (error, payload) => {
      log.debug('session:', { payload, error })
      if (error) {
        throw error
      }

      handleSessionRequest(connector)
    })

    // Subscribe to call requests
    connector.on('call_request', (error, payload) => {
      const { method, params } = payload
      log.debug('call:', { payload, error, method, params })

      if (error) {
        throw error
      }

      try {
        let message
        if (payload.method === 'eth_sign') {
          message = payload?.params?.[1]
        }
        if (method === 'personal_sign') {
          message = payload?.params?.[0]
          log.debug('personal_sign:', { message })
          if (web3Utils.isHex(message)) {
            message = web3Utils.hexToUtf8(message)
            log.debug('personal_sign:', { message })
          }
        }
        if (payload.method.includes('eth_signTypedData')) {
          if (payload.params.length && payload.params[0]) {
            message = payload?.params?.[0] ?? null
            if (web3Utils.isAddress(payload?.params?.[0] ?? '')) {
              message = payload?.params?.[1] ?? null
            }
          }
        }
        log.debug('sign message:', { message })
        if (message) {
          return handleSignRequest(message, payload, connector)
        }

        if (['eth_signTransaction', 'eth_sendTransaction'].includes(payload.method)) {
          const transaction = payload?.params?.[0] ?? null

          // // Backwards compatibility with param name change
          // if (transaction.gas && !transaction.gasLimit) {
          //   transaction.gasLimit = transaction.gas
          // }

          // We must pass a number through the bridge
          if (!transaction.gas) {
            transaction.gas = '8000000'
          }

          // Fallback for dapps sending no data
          if (!transaction.data) {
            transaction.data = '0x'
          }

          return handleTxRequest(transaction, payload, connector)
        }

        if (['wallet_addEthereumChain', 'wallet_switchEthereumChain'].includes(payload.method)) {
          return handleSwitchChainRequest(payload, connector)
        }

        if (payload.method === 'wallet_scanQrCode') {
          return handleScanRequest(payload, connector)
        }

        handleUnsupportedRequest(payload, connector)
        throw new Error(`Unsupported request: ${payload.method}`)
      } catch (e) {
        log.warn('failed handling sign request', e.message, e, { payload })
        throw e
      }
    })

    connector.on('disconnect', (error, payload) => {
      log.debug('disconnect:', { payload, error })

      if (error) {
        throw error
      }
      handleSessionDisconnect(connector)
    })

    return () => {
      connector.off('disconnect')
      connector.off('call_request')
      connector.off('session_request')
    }
  }, [
    wallet,
    activeConnector,
    handleSessionDisconnect,
    handleSessionRequest,
    handleSignRequest,
    handleTxRequest,
    handleSwitchChainRequest,
    handleUnsupportedRequest,
    handleScanRequest,
  ])

  const disconnect = useCallback(() => {
    if (activeConnector) {
      handleSessionDisconnect(activeConnector)
    }
  }, [activeConnector, handleSessionDisconnect])

  const reconnect = useCallback(async () => {
    if (!activeConnector) {
      const session = await AsyncStorage.getItem('walletconnect')
      if (session) {
        connect(session)
      }
    }
  }, [connect, activeConnector, chains])

  const loadPendingTxs = async () => {
    const txKeys = (await AsyncStorage.getAllKeys()).filter(_ => _.startsWith('GD_WALLETCONNECT_PENDING_'))
    const txs = await AsyncStorage.multiGet(txKeys)
    setPending(txs)
  }

  useEffect(() => {
    loadPendingTxs()
    if (cachedConnector) {
      log.info('cachedConnector exists not reconnecting')
      return setConnector(cachedConnector)
    }

    reconnect()
  }, [])

  useEffect(() => {
    cachedConnector = activeConnector
    const chainDetails = chains.find(_ => Number(_.chainId) === Number(activeConnector?.session?.chainId))
    log.debug('setting chain:', { chainDetails })
    setChain(chainDetails)

    // if (chains.length > 0) {
    //   const payload = {
    //     id: 1657446841779151,
    //     jsonrpc: '2.0',
    //     method: 'eth_sendTransaction',
    //     params: [
    //       {
    //         from: '0x1379510d8b1dd389d4cf1b9c6c3c8cc3136d8e56',
    //         to: '0xe3f85aad0c8dd7337427b9df5d0fb741d65eeeb5',
    //         gasPrice: '0x2540be400',
    //         gas: '0x3b90d',
    //         value: '0x2d79883d2000',
    //         data:
    //           '0x7ff36ab5000000000000000000000000000000000000000000000000003221e606b24f2900000000000000000000000000000000000000000000000000000000000000800000000000000000000000001379510d8b1dd389d4cf1b9c6c3c8cc3136d8e560000000000000000000000000000000000000000000000000000000062caa66500000000000000000000000000000000000000000000000000000000000000030000000000000000000000000be9e53fd7edac9f859882afdda116645287c629000000000000000000000000620fd5fa44be6af63715ef4e65ddfa0387ad13f500000000000000000000000034ef2cc892a88415e9f02b91bfa9c91fc0be6bd4',
    //       },
    //     ],
    //   }
    //   handleTxRequest(payload.params[0], payload, activeConnector)
    // }
  }, [activeConnector, chains, setChain, handleTxRequest])

  return {
    wcConnect: connect,
    wcConnected: activeConnector?.connected,
    wcSession: activeConnector?.session,
    wcDisconnect: disconnect,
    wcSwitchChain: switchChain,
    wcChain: chain,
    pendingTxs,
  }
}
