// @flow
import React, { useCallback, useContext, useState } from 'react'
import Config from '../../config/config'
import logger from '../logger/js-logger'
import GoodWalletLogin from '../login/GoodWalletLoginClass'
import { UserStorage } from '../userStorage/UserStorageClass'
import UserProperties from '../userStorage/UserProperties'
import getDB from '../realmdb/RealmDB'
import usePropsRefs from '../hooks/usePropsRefs'
import { GlobalTogglesContext } from '../contexts/togglesContext'
import { GoodWallet } from './GoodWalletClass'
import HDWalletProvider from './HDWalletProvider'

const log = logger.child({ from: 'GoodWalletProvider' })

export const GoodWalletContext = React.createContext({
  userStorage: undefined,
  error: undefined,
  goodWallet: undefined,
  init: undefined,
})

/**
 *
 * @param {boolean} disableLoginAndWatch - used in tests to disable server interaction
 * @returns
 */
export const GoodWalletProvider = ({ children, disableLoginAndWatch = false }) => {
  const { isLoggedInRouter } = useContext(GlobalTogglesContext)
  const [{ goodWallet, userStorage }, setWalletAndStorage] = useState({})
  const [web3Provider, setWeb3] = useState()
  const [isLoggedInJWT, setLoggedInJWT] = useState()
  const [balance, setBalance] = useState()
  const [dailyUBI, setDailyUBI] = useState()
  const [isCitizen, setIsCitizen] = useState()
  const [shouldLoginAndWatch] = usePropsRefs([disableLoginAndWatch === false])

  const db = getDB()

  const update = useCallback(
    async goodWallet => {
      const calls = [
        {
          balance: goodWallet.tokenContract.methods.balanceOf(goodWallet.account),
        },
        {
          ubi: goodWallet.UBIContract.methods.checkEntitlement(goodWallet.account),
        },
        {
          isCitizen: goodWallet.identityContract.methods.isWhitelisted(goodWallet.account),
        },
      ]

      // entitelment is separate because it depends on msg.sender
      const [[{ balance }, { ubi }, { isCitizen }]] = await goodWallet.multicallFuse.all([calls])

      setBalance(parseInt(balance))
      setDailyUBI(parseInt(ubi))
      setIsCitizen(isCitizen)
    },
    [setBalance, setDailyUBI, setIsCitizen],
  )

  const initWalletAndStorage = useCallback(
    async (seedOrWeb3, type: 'SEED' | 'METAMASK' | 'WALLETCONNECT' | 'OTHER') => {
      try {
        const wallet = new GoodWallet({
          mnemonic: type === 'SEED' ? seedOrWeb3 : undefined,
          web3: type !== 'SEED' ? seedOrWeb3 : undefined,
          web3Transport: Config.web3TransportProvider,
        })

        await wallet.ready

        // when new wallet set the web3provider for future use with usedapp
        if (type === 'SEED') {
          setWeb3(new HDWalletProvider(wallet.accounts, wallet.wallet._provider.host))
        } else {
          setWeb3(seedOrWeb3)
        }
        log.info('initWalletAndStorage wallet ready', { type, seedOrWeb3 })

        const storage = new UserStorage(wallet, db, new UserProperties(db))

        await storage.ready
        if (shouldLoginAndWatch()) {
          await Promise.all([_login(wallet, storage, false), update(wallet)])
        }

        if (isLoggedInRouter) {
          await storage.initRegistered()
          if (shouldLoginAndWatch()) {
            const { userProperties } = storage

            // only if user signed up then we can await for his properties
            // (because otherwise he wont have valid mongodb jwt)
            await userProperties.ready

            const lastBlock = userProperties.get('lastBlock') || 6400000

            log.debug('starting watchBalanceAndTXs', { lastBlock })

            wallet.watchEvents(parseInt(lastBlock), toBlock => userProperties.set('lastBlock', parseInt(toBlock)))

            wallet.balanceChanged(() => update(wallet))
          }
        }

        log.info('initWalletAndStorage storage done')

        global.userStorage = storage
        global.wallet = wallet
        setWalletAndStorage({ goodWallet: wallet, userStorage: storage })

        log.info('initWalletAndStorage done')
        return [wallet, storage]
      } catch (e) {
        log.error('failed initializing wallet and userstorage:', e.message, e)

        throw e
      }
    },
    [setWeb3, setWalletAndStorage, isLoggedInRouter],
  )

  const _login = useCallback(
    async (wallet, storage, refresh) => {
      try {
        const walletLogin = new GoodWalletLogin(wallet, storage)

        // the login also re-initialize the api with new jwt

        const { jwt } = await walletLogin.auth(refresh)
        setLoggedInJWT(walletLogin)

        log.info('walletLogin', { jwt, refresh })
        return walletLogin
      } catch (e) {
        //retry once in case jwt needs refresh
        if (!refresh) {
          return _login(wallet, storage, true)
        }
        log.error('failed auth:', e.message, e)
        throw e
      }
    },
    [setLoggedInJWT],
  )

  const login = useCallback(
    async refresh => {
      if (isLoggedInJWT) {
        const { decoded, jwt } = await isLoggedInJWT.validateJWTExistenceAndExpiration()
        if (!decoded || !jwt) {
          refresh = true
        }
      }
      if ((!refresh && isLoggedInJWT) || !goodWallet || !userStorage) {
        return isLoggedInJWT
      }

      const result = await _login(goodWallet, userStorage, refresh)
      return result
    },
    [goodWallet, userStorage, isLoggedInJWT, _login],
  )

  return (
    <GoodWalletContext.Provider
      value={{
        userStorage,
        goodWallet,
        initWalletAndStorage,
        web3Provider,
        login,
        isLoggedInJWT,
        balance,
        dailyUBI,
        isCitizen,
      }}
    >
      {children}
    </GoodWalletContext.Provider>
  )
}

export const useWallet = () => {
  const { goodWallet } = useContext(GoodWalletContext)

  return goodWallet
}
export const useUserStorage = (): UserStorage => {
  const { userStorage } = useContext(GoodWalletContext)

  return userStorage
}
export const useWalletData = () => {
  const { dailyUBI, balance, isCitizen } = useContext(GoodWalletContext)

  return { dailyUBI, balance, isCitizen }
}
