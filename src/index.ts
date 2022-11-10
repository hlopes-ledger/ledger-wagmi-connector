import {
  loadConnectKit,
  LedgerConnectKit,
  SupportedProviders,
  SupportedProviderImplementations
} from '@ledgerhq/connect-kit-loader';
import { providers } from 'ethers';
import { getAddress } from 'ethers/lib/utils';
import {
  Connector,
  normalizeChainId,
  ProviderRpcError,
  UserRejectedRequestError,
  Chain,
  RpcError,
  ConnectorData
} from '@wagmi/core';
import {
  getDebugLogger,
  getErrorLogger,
  enableDebugLogs
} from './lib/logger';

const log = getDebugLogger('LWC');
const logError = getErrorLogger('LWC');

interface EthereumProvider {
  providers?: EthereumProvider[];
  request(...args: unknown[]): Promise<unknown>;
  disconnect(): Promise<void>;
  emit(eventName: string | symbol, ...args: any[]): boolean;
  on(...args: unknown[]): void;
  removeListener(...args: unknown[]): void;
}

type LedgerConnectorOptions = {
  bridge?: string;
  infuraId?: string;
  rpc?: { [chainId: number]: string };

  enableDebugLogs?: boolean;

  /**
   * MetaMask and other injected providers do not support programmatic disconnect.
   * This flag simulates the disconnect behavior by keeping track of connection status in storage.
   * @see https://github.com/MetaMask/metamask-extension/issues/10353
   * @default true
   */
   shimDisconnect?: boolean;
}

type LedgerSigner = providers.JsonRpcSigner;

export class LedgerConnector extends Connector<
  EthereumProvider,
  LedgerConnectorOptions,
  LedgerSigner
> {
  readonly id = 'ledger';
  readonly name = 'Ledger';
  readonly ready = true;

  #connectKitPromise: Promise<LedgerConnectKit>;
  #provider?: EthereumProvider;
  #providerImplementation?: SupportedProviderImplementations;

  protected shimDisconnectKey = 'ledger.shimDisconnect';

  constructor({
    chains,
    options = { shimDisconnect: true, enableDebugLogs: false },
  }: {
    chains?: Chain[]
    options?: LedgerConnectorOptions
  } = {}) {
    super({ chains, options });

    if (options.enableDebugLogs) {
      enableDebugLogs();
    }

    log('constructor');
    log('chains are', chains);
    log('options are', options);

    this.#connectKitPromise = loadConnectKit();
  }

  async connect({ chainId }: { chainId?: number } = {}): Promise<Required<ConnectorData>> {
    log('connect', chainId);

    try {
      log('getting Connect Kit');
      const connectKit = await this.#connectKitPromise;

      if (this.options.enableDebugLogs) {
        connectKit.enableDebugLogs();
      }

      log('checking Connect support');
      const checkSupportResult = connectKit.checkSupport({
        providerType: SupportedProviders.Ethereum,
        chainId: chainId,
        infuraId: this.options.infuraId,
        rpc: this.options.rpc,
      });
      // make the current provider implementation available
      this.#providerImplementation = checkSupportResult.providerImplementation;

      const provider = await this.getProvider();

      if (provider.on) {
        log('assigning event handlers');
        provider.on('accountsChanged', this.onAccountsChanged);
        provider.on('chainChanged', this.onChainChanged);
        provider.on('disconnect', this.onDisconnect);
      }

      this.emit('message', { type: 'connecting' });

      const account = await this.getAccount();
      const id = await this.getChainId();
      const unsupported = this.isChainUnsupported(id);
      log('unsupported is', unsupported);

      // TODO we currently dont pass a chainId to connect()?
      if (chainId && id !== chainId) {
        log('wallet set a different chainId', id);
      }

      // add shim to storage signalling wallet is connected
      if (
        this.options?.shimDisconnect &&
        this.#providerImplementation === SupportedProviderImplementations.LedgerConnect
      ) {
        log('setting shimDisconnect state', unsupported);
        localStorage.setItem(this.shimDisconnectKey, 'true');
      }

      return {
        account,
        chain: { id, unsupported },
        provider: new providers.Web3Provider(
          <providers.ExternalProvider>provider,
        ),
      };
    } catch (error) {
      if ((<ProviderRpcError>error).code === 4001) {
        logError('user rejected', error);
        throw new UserRejectedRequestError(error);
      }
      if ((<RpcError>error).code === -32002) {
        logError('RPC error -32002, Resource unavailable', error);
        throw (error instanceof Error) ? error : new Error(String(error));
      }

      logError('error in connect', error);
      throw error;
    }
  }

  async disconnect() {
    log('disconnect');

    const provider = await this.getProvider();

    // call disconnect if provider is WalletConnect
    if (
      !!provider &&
      this.#providerImplementation === SupportedProviderImplementations.WalletConnect
    ) {
      log('disconnecting WalletConnect');
      await provider.disconnect();
    }

    if (provider.removeListener) {
      log('removing event handlers');
      provider.removeListener('accountsChanged', this.onAccountsChanged);
      provider.removeListener('chainChanged', this.onChainChanged);
      provider.removeListener('disconnect', this.onDisconnect);
    }

    // remove shim signalling wallet is disconnected
    if (
      this.options?.shimDisconnect &&
      this.#providerImplementation === SupportedProviderImplementations.LedgerConnect
    ) {
      log('removing shim/walletconnect state');
      this.options?.shimDisconnect && typeof localStorage !== 'undefined' &&
        localStorage.removeItem(this.shimDisconnectKey);
    }
  }

  async getAccount() {
    log('getAccount');

    const provider = await this.getProvider();
    const accounts = await provider.request({
      method: 'eth_requestAccounts'
    }) as string[];
    const account = getAddress(accounts[0] as string);
    log('account is', account);

    return account;
  }

  async getChainId() {
    log('getChainId');

    const provider = await this.getProvider();
    const chainId = await provider.request({
      method: 'eth_chainId'
    }) as number;
    log('chainId is', chainId, normalizeChainId(chainId));

    return normalizeChainId(chainId);
  }

  async getProvider() {
    log('getProvider');

    if (!this.#provider) {
      log('getting provider from Connect Kit');
      const connectKit = await this.#connectKitPromise;
      this.#provider = await connectKit.getProvider() as EthereumProvider;
      log('provider is', this.#provider);
    }
    return this.#provider;
  }

  async getSigner() {
    log('getSigner');

    const [provider, account] = await Promise.all([
      this.getProvider(),
      this.getAccount(),
    ]);
    return new providers.Web3Provider(
      provider as providers.ExternalProvider
    ).getSigner(account);
  }

  async isAuthorized() {
    log('isAuthorized');

    try {
      // don't authorize if shim does not exist in storage
      if (
        this.options?.shimDisconnect &&
        typeof localStorage !== 'undefined' &&
        localStorage.getItem(this.shimDisconnectKey)
      ) {
        return false;
      }

      const provider = await this.getProvider();
      const accounts = await provider.request({
        method: 'eth_accounts',
      }) as string[];
      const account = accounts[0];
      log('account', account);

      return !!account;
    } catch {
      return false;
    }
  }

  protected onAccountsChanged = (accounts: string[]) => {
    log('onAccountsChanged');

    if (accounts.length === 0) this.emit('disconnect');
    else this.emit('change', { account: getAddress(<string>accounts[0]) });
  }

  protected onChainChanged = (chainId: number | string) => {
    log('onChainChanged');

    const id = normalizeChainId(chainId);
    const unsupported = this.isChainUnsupported(id);
    this.emit('change', { chain: { id, unsupported } });
  }

  protected onDisconnect = () => {
    log('onDisconnect');
    this.emit('disconnect');

    if (this.options?.shimDisconnect && typeof localStorage !== 'undefined') {
      log('removing shimDisconnect flag');
      localStorage.removeItem(this.shimDisconnectKey);
    }
  }
}
