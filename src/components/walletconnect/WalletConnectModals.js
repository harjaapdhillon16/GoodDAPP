// @flow
// libraries
import React, { useCallback, useMemo } from 'react'
import { Linking, ScrollView, View } from 'react-native'
import { useTheme } from 'react-native-paper'
import { t } from '@lingui/macro'
import { entries } from 'lodash'
import { isAddress } from 'web3-utils'
import Icon from 'react-native-vector-icons/MaterialIcons'
import { Image, Text } from '../common'
import QrReader from '../dashboard/QR/QRScanner'

import logger from '../../lib/logger/js-logger'
import { withStyles } from '../../lib/styles'

// components

// import { type IClientMeta } from '@walletconnect/types'

// hooks
import { useDialog } from '../../lib/dialog/useDialog'

const log = logger.child({ from: 'WalletConnectModals' })
const getStylesFromProps = ({ theme }) => {
  const { colors, sizes } = theme
  const { defaultDouble } = sizes
  const { lightBlue } = colors

  return {
    container: {
      width: '95%',
      alignSelf: 'center',
    },
    header: {
      display: 'flex',
      alignItems: 'center',
    },
    detailsView: {
      width: '100%',
      marginTop: 20,
      marginBottom: 10,
      justifyContent: 'space-evenly',
      padding: 10,
      flexDirection: 'row',
      backgroundColor: '#eef0f9',
    },
    detailHeading: {
      fontSize: defaultDouble,
    },
    detail: {
      fontSize: 10,
    },

    infoView: {
      alignItems: 'flex-start',
      marginTop: 20,
      width: '100%',
      textAlign: 'start',
      fontSize: 14,
      maxHeight: 400,
    },
    labelText: {
      color: lightBlue,
    },
    data: {
      fontSize: 14,
      width: '100%',
    },
    boldText: {
      fontWeight: 'bold',
    },
    vendorName: {
      fontSize: 20,
    },
  }
}

export const WcHeader = withStyles(getStylesFromProps)(({ styles, session: { peerMeta, chainId } = {} }) => {
  const dappName = peerMeta?.name
  const dappURL = peerMeta?.url
  const dappIcon = peerMeta?.icons?.[0]
  chainId = chainId || peerMeta?.chainId || 1
  return (
    <>
      <View style={styles.header}>
        <Image
          source={{ uri: dappIcon }}
          style={{
            width: 50,
            height: 'auto',
            backgroundColor: 'transparent',
            borderRadius: 18,
          }}
        />
        <Text style={styles.vendorName}>{dappName}</Text>
      </View>
      <View style={styles.detailsView}>
        <View>
          <Text style={styles.detailHeading}>{t`Website`}</Text>
          <Text style={styles.detail}>{dappURL}</Text>
        </View>
        <View>
          <Text style={styles.detailHeading}>{t`Chain`}</Text>
          <Text style={styles.detail}>{chainId}</Text>
        </View>
      </View>
    </>
  )
})

export const ContractCall = ({ styles, txJson, explorer, method }) => {
  const { decodedTx = {}, gasStatus, ...rest } = txJson
  const { decoded: { name, params } = {}, error } = decodedTx
  const txParams = entries(rest).map(e => ({ name: e[0], value: e[1] }))
  const isSign = method.includes('sign')
  return (
    <View style={styles.infoView}>
      {!isSign && error && gasStatus.hasEnoughGas && (
        <Text color="red" fontWeight="bold">
          {t`This transaction might fail to save gas we recommend not to execute it`}
        </Text>
      )}
      {!isSign && !gasStatus.hasEnoughGas && (
        <Text color="red" fontWeight="bold">
          {t`Not enough balance to execute transaction. Balance: ${gasStatus.balance} Required: ${
            gasStatus.gasRequired
          }`}
        </Text>
      )}
      {name && (
        <>
          <Text fontSize={16} fontWeight={'bold'}>
            Contrat Call:
          </Text>
          <Text style={styles.labelText}>{t`Contract Method`}</Text>
          <Text fontSize={12} textAlign={'start'}>
            {name}
          </Text>
        </>
      )}
      {params &&
        params.map(p => (
          <React.Fragment key={p.name}>
            <Text style={styles.labelText}>{p.name}</Text>
            <Text fontSize={12} textAlign={'start'}>
              {p.value}
              {explorer && isAddress(p.value) && (
                <Icon name="launch" onPress={() => Linking.openURL(`${explorer}/address/${p.value}`)} />
              )}
            </Text>
          </React.Fragment>
        ))}
      <Text fontSize={16} fontWeight={'bold'}>
        Transaction Request:
      </Text>
      {txParams.map(p => (
        <React.Fragment key={p.name}>
          <Text style={styles.labelText}>{p.name}</Text>
          <Text fontSize={12} textAlign={'start'}>
            {['gas', 'gasPrice', 'gasLimit', 'value'].includes(p.name) ? Number(p.value) : p.value}
            {explorer && isAddress(p.value) && (
              <Icon name="launch" onPress={() => Linking.openURL(`${explorer}/address/${p.value}`)} />
            )}
          </Text>
        </React.Fragment>
      ))}
    </View>
  )
}
const Approve = ({ styles, session, payload, message, modalType, walletAddress, onScan, explorer }) => {
  const requestText = useMemo(() => {
    switch (modalType) {
      default:
      case 'sign':
        return t`wants to sign this message:`
      case 'tx':
        return payload.method.includes('sign')
          ? t`wants to sign this transaction:`
          : t`wants to execute this transaction:`
      case 'connect':
        return t`wants to connect to your wallet:`
      case 'switchchain':
        return t`wants to switch chain:`
      case 'scan':
        return t`wants you to scan a QR code:`
    }
  }, [modalType])

  const labelText = useMemo(() => {
    switch (modalType) {
      default:
      case 'sign':
        return t`Message:`
      case 'connect':
        return t`Account:`
      case 'switchchain':
        return t`Chain:`
      case 'tx':
      case 'scan':
        return ''
    }
  }, [modalType])

  const displayData = useMemo(() => {
    switch (modalType) {
      case 'sign': {
        if (payload.method === 'eth_signTypedData') {
          const parsed = JSON.parse(message)
          delete parsed.types //dont show types to user
          return JSON.stringify(parsed, null, 4)
        }
        return message
      }
      case 'tx': {
        return <ContractCall styles={styles} txJson={message} explorer={explorer} method={payload.method} />
      }
      case 'connect':
        return walletAddress
      default:
        return message
    }
  }, [modalType])

  return (
    <View style={styles.container}>
      <WcHeader session={session} />
      <Text style={styles.boldText}>{requestText}</Text>
      <View style={styles.infoView}>
        <Text style={styles.labelText}>{labelText}</Text>
        <ScrollView style={styles.data} showsHorizontalScrollIndicator={false}>
          {modalType === 'scan' && <QrReader delay={300} onError={() => {}} onScan={onScan} />}
          {['connect', 'sign', 'switchchain'].includes(modalType) && (
            <Text fontSize={12} textAlign={'start'}>
              {displayData}
            </Text>
          )}
          {modalType === 'tx' && displayData}
        </ScrollView>
      </View>
    </View>
  )
}

const ApproveModal = withStyles(getStylesFromProps)(Approve)

export const useSessionApproveModal = () => {
  const { showDialog, isDialogShown, showErrorDialog, hideDialog } = useDialog()
  const theme = useTheme()
  const { colors, sizes } = theme
  const { borderRadius } = sizes
  const { primary } = colors

  const show = useCallback(({ session, payload, message, walletAddress, onReject, onApprove, modalType, explorer }) => {
    log.debug('showing dialog', { session, payload, message, walletAddress, onReject, onApprove, modalType })
    if (modalType === 'error') {
      return showErrorDialog(t`Unsupported request ${payload.method}`)
    }

    try {
      showDialog({
        showCloseButtons: false,
        isMinHeight: false,
        showButtons: true,
        content: (
          <ApproveModal
            payload={payload}
            message={message}
            session={session}
            walletAddress={walletAddress}
            modalType={modalType}
            explorer={explorer}
            onScan={data => {
              if (!data) {
                return
              }
              const ok = onApprove(data)
              if (!ok) {
                showErrorDialog(t`Invalid QR Value: ${data}`)
              }
              hideDialog()
            }}
          />
        ),
        buttonsContainerStyle: {
          width: '95%',
          flexDirection: 'row',
          justifyContent: 'space-between',
          marginTop: sizes.defaultDouble,
        },
        buttons: [
          {
            text: 'Reject',
            onPress: async dismiss => {
              // do something
              try {
                await onReject()
                dismiss()
              } catch (e) {
                log.error('failed rejecting', e.message, e, { dialogShown: true, payload, modalType })
                showErrorDialog(t`Could not reject request.`)
              }
            },
            color: 'red',
            style: {
              width: '48%',
              color: 'blue',
              marginRight: 10,
              borderRadius,
            },
          },
          {
            text: 'Approve',
            onPress: async dismiss => {
              // do something
              try {
                await onApprove()
                dismiss()
              } catch (e) {
                log.error('failed approving', e.message, e, { dialogShown: true, payload, modalType })
                showErrorDialog(t`Could not approve request.`)
              }
            },
            color: 'white',
            style: {
              borderRadius,
              width: '48%',
              backgroundColor: primary,
              display: modalType !== 'scan' ? 'block' : 'none',
            },
          },
        ],
      })
    } catch (e) {
      log.error('failed showing dialog', e.message, e, { dialogShown: true, payload, modalType })

      showErrorDialog(t`Unable to process request: ${e.message}`)
    }
  }, [])

  return { show, isDialogShown }
}
