# Staking guide

Staking means locking your AUR to back a validator. Validators run the computers that confirm payments. In return, new AUR is shared with the validators and everyone who staked with them.

## How it works

1. You choose a validator in the wallet's **Stake** tab and enter an amount.
2. Your coins are locked. They still belong to you.
3. Rewards build up as blocks are confirmed. Press **Claim** to move them to your balance.
4. To get your coins back, press **Unstake**. They return after a waiting period (the "unbonding" period; 28 days by default on mainnet), shown under **Coming back to you**.

## Choosing a validator

Look at three things in the table:

- **Share of network.** Spreading stake across many validators makes the network safer. Pick one that is not already huge. No validator can have more than a capped share of the voting power.
- **Fee cut (commission).** The part of your rewards the validator keeps.
- **Status.** Avoid ones marked *paused* (they missed too many blocks) or *banned* (they cheated and were penalised).

## Risks

- **Penalties.** If your validator cheats (signs two different blocks at the same height), part of the stake behind it is cut and burned. Pause-level mistakes such as long downtime have a smaller penalty. Choose reliable validators.
- **Waiting period.** You cannot spend staked coins until the unbonding period ends.
- **Unaudited software.** AUREN has not been independently audited yet. Only stake what you can afford to lose.

## Rewards

New AUR is issued each block (3% a year at the start, falling by 15% a year down to a floor of 0.5%). 10% of it goes to the node-reward pool ([Node rewards](node-rewards.md)) and the rest to validators and the people who staked with them, after validator commission. Fees paid by users are burned, not paid out. Details: [Tokenomics](tokenomics.md).

## Run your own validator

If you want to run a validator yourself, read [Validators](validators.md). It needs a larger stake and a reliable computer.
