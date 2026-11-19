export const active = (rows = []) => rows.filter((row) => !row.deleted);

export function plotLedger(data, range = {}) {
  const plots = active(data.plots || []);
  const plotMap = new Map(plots.map((plot) => [plot.id, {
    plotId: plot.id,
    plotName: plot.name,
    ownerName: plot.ownerName || 'เจ้าของสวน',
    gross: 0,
    deductions: 0,
    expenses: 0,
    net: 0,
    kg: 0,
    rounds: 0,
    shares: [],
  }]));
  const inside = (date) => (!range.from || date >= range.from) && (!range.to || date <= range.to);

  for (const sale of active(data.sales || [])) {
    if (!inside(sale.date)) continue;
    const allocations = sale.allocations || [];
    const totalKg = allocations.reduce((sum, allocation) => sum + Number(allocation.kg || 0), 0) || Number(sale.totalKg || 0);
    for (const allocation of allocations) {
      const row = plotMap.get(allocation.plotId);
      if (!row) continue;
      const kg = Number(allocation.kg || 0);
      const gross = kg * Number(sale.priceKg || 0);
      const buyerDeduction = totalKg > 0 ? Number(sale.deductions || 0) * kg / totalKg : 0;
      row.kg += kg;
      row.gross += gross;
      row.deductions += buyerDeduction;
    }
  }

  for (const expense of active(data.expenses || [])) {
    if (!inside(expense.date)) continue;
    for (const allocation of expense.allocations || []) {
      const row = plotMap.get(allocation.plotId);
      if (row) row.expenses += Number(allocation.amount || 0);
    }
  }

  for (const tapping of active(data.tappings || [])) {
    if (inside(tapping.date)) {
      const row = plotMap.get(tapping.plotId);
      if (row) row.rounds += Number(tapping.rounds || 0);
    }
  }

  const shares = active(data.shares || []);
  for (const row of plotMap.values()) {
    row.net = row.gross - row.deductions - row.expenses;
    row.shares = shares.filter((share) => share.plotId === row.plotId).map((share) => ({
      ...share,
      grossAmount: row.gross * Number(share.percent || 0) / 100,
      deductionAmount: row.deductions * Number(share.percent || 0) / 100,
      expenseAmount: row.expenses * Number(share.percent || 0) / 100,
      netAmount: row.net * Number(share.percent || 0) / 100,
    }));
  }
  return [...plotMap.values()];
}

export function shareTotals(ledger) {
  const people = new Map();
  for (const plot of ledger) for (const share of plot.shares) {
    const key = `${share.personName}|${share.role}`;
    const row = people.get(key) || {
      personName: share.personName,
      role: share.role,
      gross: 0,
      deductions: 0,
      expenses: 0,
      net: 0,
      plots: new Set(),
      byPlot: new Map(),
    };
    row.gross += share.grossAmount;
    row.deductions += share.deductionAmount;
    row.expenses += share.expenseAmount;
    row.net += share.netAmount;
    row.plots.add(plot.plotName);
    const detail = row.byPlot.get(plot.plotId) || { plotId: plot.plotId, plotName: plot.plotName, percent: 0, gross: 0, deductions: 0, expenses: 0, net: 0 };
    detail.percent += Number(share.percent || 0);
    detail.gross += share.grossAmount;
    detail.deductions += share.deductionAmount;
    detail.expenses += share.expenseAmount;
    detail.net += share.netAmount;
    row.byPlot.set(plot.plotId, detail);
    people.set(key, row);
  }
  return [...people.values()].map((row) => {
    const { byPlot, plots, ...summary } = row;
    return { ...summary, plots: [...plots], byPlot: [...byPlot.values()] };
  });
}

export function monthlySeries(data, year, selectedPlotIds = []) {
  const months = Array.from({ length: 12 }, (_, index) => ({ label: new Date(year, index, 1).toLocaleDateString('th-TH', { month: 'short' }), gross: 0, deductions: 0, expenses: 0, net: 0, rounds: 0 }));
  const allowed = selectedPlotIds.length ? new Set(selectedPlotIds) : null;
  const ledgerByMonth = new Map();
  for (const sale of active(data.sales || [])) {
    if (!sale.date?.startsWith(`${year}-`)) continue;
    const month = Number(sale.date.slice(5, 7)) - 1;
    const totalKg = (sale.allocations || []).reduce((sum,allocation)=>sum+Number(allocation.kg||0),0) || Number(sale.totalKg||0);
    for (const allocation of sale.allocations || []) {
      if (allowed && !allowed.has(allocation.plotId)) continue;
      const kg=Number(allocation.kg||0);
      months[month].gross += kg * Number(sale.priceKg || 0);
      if(totalKg>0)months[month].deductions+=Number(sale.deductions||0)*kg/totalKg;
    }
  }
  for (const expense of active(data.expenses || [])) {
    if (!expense.date?.startsWith(`${year}-`)) continue;
    const month = Number(expense.date.slice(5, 7)) - 1;
    for (const allocation of expense.allocations || []) {
      if (!allowed || allowed.has(allocation.plotId)) months[month].expenses += Number(allocation.amount || 0);
    }
  }
  for (const tapping of active(data.tappings || [])) {
    if (!tapping.date?.startsWith(`${year}-`) || (allowed && !allowed.has(tapping.plotId))) continue;
    months[Number(tapping.date.slice(5, 7)) - 1].rounds += Number(tapping.rounds || 0);
  }
  months.forEach((month) => { month.net = month.gross - month.deductions - month.expenses; });
  return months;
}
