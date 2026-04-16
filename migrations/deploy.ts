import * as anchor from "@coral-xyz/anchor";

export const deploy = async () => {
  // This is the default deploy script for Anchor programs
  // It is meant to be modified as needed for your program

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  console.log("Deploying AEAP programs...");
  console.log("Provider cluster:", provider.connection.rpcEndpoint);
  console.log("Wallet:", provider.publicKey.toString());

  // The actual deployment happens via `anchor deploy`
  // This file serves as a migration entry point
};
