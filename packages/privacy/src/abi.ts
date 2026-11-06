import { ABIRailgunSmartWallet } from '@railgun-community/engine';
import { Interface } from 'ethers';
export const railgunABI = ABIRailgunSmartWallet;
export const railgunInterface = new Interface(railgunABI);
