const abi = require("./abi.json");
const { default: BigNumber } = require("bignumber.js");
const { getConfig } = require("../helper/cache");
const { cachedGraphQuery } = require("../helper/cache");
const { sumTokens2, } = require("../helper/unwrapLPs");
const { getAmounts } = require("./iziswap")

// The Graph
const graphUrlList = {
  ethereum: 'https://api.studio.thegraph.com/query/40045/solv-payable-factory-prod/version/latest',
  bsc: 'https://api.thegraph.com/subgraphs/name/slov-payable/solv-v3-earn-factory',
  arbitrum: 'https://api.studio.thegraph.com/query/40045/solv-payable-factory-arbitrum/version/latest',
  mantle: 'http://api.0xgraph.xyz/subgraphs/name/solv-payable-factory-mentle-0xgraph',
}

const slotListUrl = 'https://raw.githubusercontent.com/solv-finance-dev/solv-protocol-rwa-slot/main/slot.json';

const addressUrl = 'https://raw.githubusercontent.com/solv-finance-dev/slov-protocol-defillama/main/solv-funds.json';

async function borrowed(ts) {
  const { api } = arguments[3];
  const network = api.chain;

  let address = (await getConfig('solv-protocol/funds', addressUrl));
  const depositAddress = filterDepositAddress(network, address);

  const graphData = await getGraphData(ts, network, api);
  if (graphData.pools.length > 0) {
    const poolLists = graphData.pools;

    var pools = poolLists.filter((value) => {
      return depositAddress.length == 0 || depositAddress.indexOf(value.vault) == -1;
    });

    const poolConcretes = await concrete(pools, api);
    const nav = await api.multiCall({
      abi: abi.getSubscribeNav,
      calls: pools.map((index) => ({
        target: index.navOracle,
        params: [index.poolId, ts * 1000]
      })),
    })

    const poolTotalValues = await api.multiCall({
      abi: abi.slotTotalValue,
      calls: pools.map((index) => ({
        target: poolConcretes[index.contractAddress],
        params: [index.openFundShareSlot]
      })),
    })

    const poolBaseInfos = await api.multiCall({
      abi: abi.slotBaseInfo,
      calls: pools.map((index) => ({
        target: poolConcretes[index.contractAddress],
        params: [index.openFundShareSlot]
      })),
    })

    const poolDecimalList = await api.multiCall({
      abi: abi.decimals,
      calls: poolBaseInfos.map(i => i[1]),
    })

    for (let i = 0; i < poolTotalValues.length; i++) {
      const decimals = poolDecimalList[i];
      const balance = BigNumber(poolTotalValues[i]).div(BigNumber(10).pow(18 - decimals)).times(BigNumber(nav[i].nav_).div(BigNumber(10).pow(decimals))).toNumber();
      api.add(poolBaseInfos[i][1], balance)
    }
  }
  return api.getBalances()
}

async function tvl(ts, _, _1, { api }) {
  let address = (await getConfig('solv-protocol/funds', addressUrl));

  await gm(api, address);
  await mux(api, address);
  await vaultBalance(api, address);

  return api.getBalances();
}

async function gm(api, address) {
  let gm = address[api.chain]["gm"];

  let tokens = []
  for (const pool of gm["depositAddress"]) {
    for (const address of gm["gmTokens"]) {
      tokens.push({ address, pool })
    }
  }

  await sumTokens2({ api, tokensAndOwners: tokens.map(i => [i.address, i.pool]), permitFailure: true });
}

async function mux(api, address) {
  let mux = address[api.chain]["mux"];

  const amount = await api.call({ abi: abi.stakedMlpAmount, target: mux.pool, params: mux.account });

  api.add(mux.lp, amount)
}


async function mantleTvl(ts, _, _1, { api }) {
  let address = (await getConfig('solv-protocol/funds', addressUrl));

  await klp(api, address);
  await iziswap(api, address);
  await lendle(api, address);
  await vaultBalance(api, address);

  return api.getBalances();
}

async function klp(api, address) {
  let klp = address[api.chain]["klp"];

  const stakedAmounts = await api.multiCall({
    abi: abi.stakedAmountsAbi,
    calls: klp["klpPool"].map((pool) => ({
      target: klp["address"],
      params: [pool]
    })),
  })

  stakedAmounts.forEach(amount => {
    api.add(klp["address"], amount)
  })
}

async function iziswap(api, address) {
  let iziswapData = address[api.chain]["iziswap"];

  const iziswap = iziswapData.liquidityManager;
  const owner = iziswapData.owner;

  let liquidities = [];
  for (let i = 0; i < owner.length; i++) {
    liquidities.push(liquidity(api, iziswap, owner[i]))
  }

  await Promise.all(liquidities);
}

async function liquidity(api, iziswap, owner) {
  const balanceOf = await api.call({ abi: abi.balanceOf, target: iziswap, params: [owner] })

  let indexs = [];
  for (let i = 0; i < balanceOf; i++) {
    indexs.push(i);
  }

  const tokenIds = await api.multiCall({
    abi: abi.tokenOfOwnerByIndex,
    calls: indexs.map((index) => ({
      target: iziswap,
      params: [owner, index]
    })),
  })

  const liquidities = await api.multiCall({
    abi: abi.liquidities,
    calls: tokenIds.map((tokenId) => ({
      target: iziswap,
      params: [tokenId]
    }))
  })

  const poolMetas = await api.multiCall({
    abi: abi.poolMetas,
    calls: liquidities.map((liquidity) => ({
      target: iziswap,
      params: [liquidity[7]]
    }))
  })

  let tokenList = [...poolMetas]

  let poolList = await api.multiCall({
    abi: abi.pool,
    target: iziswap,
    calls: poolMetas.map((pool) => ({
      params: [pool[0], pool[1], pool[2]]
    }))
  })
  let state = await api.multiCall({
    abi: abi.state,
    calls: poolList.map((pool) => ({
      target: pool
    }))
  })

  tokenList.forEach((token, index) => {
    const amounts = getAmounts(state[index], liquidities[index])
    api.add(token[0], amounts.amountX)
    api.add(token[1], amounts.amountY)
  })
}

async function concrete(slots, api) {
  var slotsList = [];
  var only = {};
  for (var i = 0; i < slots.length; i++) {
    if (!only[slots[i].contractAddress]) {
      slotsList.push(slots[i]);
      only[slots[i].contractAddress] = true;
    }
  }

  const concreteLists = await api.multiCall({
    calls: slotsList.map((index) => index.contractAddress),
    abi: abi.concrete,
  })

  let concretes = {};
  for (var k = 0; k < concreteLists.length; k++) {
    concretes[slotsList[k].contractAddress] = concreteLists[k];
  }

  return concretes;
}

async function lendle(api, address) {
  let lendleData = address[api.chain]["lendle"];

  const balance = await api.call({ abi: abi.balanceOf, target: lendleData.aToken, params: lendleData.account.user });

  api.add(lendleData.account.ethAddress, balance)
}

async function vaultBalance(api, address) {
  const network = api.chain;
  const depositAddress = filterDepositAddress(network, address);
  const graphData = await getGraphData(api.timestamp, network, api);

  if (graphData.pools.length > 0) {
    const poolLists = graphData.pools;

    var pools = poolLists.filter((value) => {
      return depositAddress.length > 0 && depositAddress.indexOf(value.vault) > -1;
    });

    const poolConcretes = await concrete(pools, api);

    const poolBaseInfos = await api.multiCall({
      abi: abi.slotBaseInfo,
      calls: pools.map((index) => ({
        target: poolConcretes[index.contractAddress],
        params: [index.openFundShareSlot]
      })),
    })

    let vaults = {};
    for (const key in pools) {
      vaults[`${poolBaseInfos[key][1].toLowerCase()}-${pools[key]["vault"].toLowerCase()}`] = [poolBaseInfos[key][1], pools[key]["vault"]]
    }

    const balances = await api.multiCall({
      abi: abi.balanceOf,
      calls: Object.values(vaults).map((index) => ({
        target: index[0],
        params: [index[1]]
      })),
    })

    for (const key in balances) {
      api.add(Object.values(vaults)[key][0], balances[key])
    }
  }
}


async function getGraphData(timestamp, chain, api) {
  let rwaSlot = (await getConfig('solv-protocol/slots', slotListUrl));

  const slotDataQuery = `query BondSlotInfos {
            poolOrderInfos(first: 1000  where:{fundraisingEndTime_gt:${timestamp}, openFundShareSlot_not_in: ${JSON.stringify(rwaSlot)}}) {
              marketContractAddress
              contractAddress
              navOracle
              poolId
              vault
              openFundShareSlot
          }
        }`;
  const data = (await cachedGraphQuery(`solv-protocol/funds-graph-data/${chain}`, graphUrlList[chain], slotDataQuery, { api, }));

  let poolList = [];
  if (data != undefined && data.poolOrderInfos != undefined) {
    poolList = data.poolOrderInfos;
  }

  return {
    pools: poolList
  };
}

function filterDepositAddress(network, address) {
  let depositAddresses = [];
  if (address[network]) {
    if (address[network]["gm"]) {
      for (let depositAddress of address[network]["gm"]["depositAddress"]) {
        depositAddresses.push(depositAddress.toLowerCase())
      }
    }
    if (address[network]["mux"]) {
      depositAddresses.push(address[network]["mux"]["account"].toLowerCase())
    }
    if (address[network]["klp"]) {
      for (let poolAddress of address[network]["klp"]["klpPool"]) {
        depositAddresses.push(poolAddress.toLowerCase())
      }
    }
    if (address[network]["iziswap"]) {
      for (let owner of address[network]["iziswap"]["owner"]) {
        depositAddresses.push(owner.toLowerCase())
      }
    }
    if (address[network]["lendle"]) {
      depositAddresses.push(address[network]["lendle"]["account"]["user"].toLowerCase())
    }
  }

  return depositAddresses;
}

// node test.js projects/solv-protocol-funds
module.exports = {
  arbitrum: {
    tvl,
    borrowed: borrowed,
  },
  mantle: {
    tvl: mantleTvl,
    borrowed: borrowed,
  }
};
