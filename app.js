/* =====================================================================
   PRECHARGE MONITOR — dashboard logic
   Fill in the same Firebase project details you used in the .ino file.
   ===================================================================== */

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCko3-tXU6Cst8l9IX_mjyUReczwnbh4J4",
  databaseURL: "https://precharge-monitoring-default-rtdb.asia-southeast1.firebasedatabase.app/",
  projectId: "precharge-monitoring"
};

// Comparator threshold used in firmware (ADC_THRESHOLD = 3476 @ 12-bit / 3.3V)
const COMP_THRESHOLD_VOLTS = (3476 * 3.3 / 4095).toFixed(2);

firebase.initializeApp(FIREBASE_CONFIG);
const db = firebase.database();

firebase.auth().signInAnonymously().catch((err) => {
  console.error("Anonymous sign-in failed:", err.message);
});

// ---------------------------------------------------------------------
// Connection status pill
// ---------------------------------------------------------------------
const statusPill = document.getElementById("status-pill");
const statusText = document.getElementById("status-text");

db.ref(".info/connected").on("value", (snap) => {
  const online = snap.val() === true;
  statusPill.classList.toggle("online", online);
  statusPill.classList.toggle("offline", !online);
  statusText.textContent = online ? "LIVE" : "OFFLINE";
});

// ---------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------
const clockEl = document.getElementById("clock");
function tickClock() {
  clockEl.textContent = new Date().toLocaleTimeString();
}
setInterval(tickClock, 1000);
tickClock();

// ---------------------------------------------------------------------
// Stage -> stepper node/edge mapping
// ---------------------------------------------------------------------
const STAGE_NODE_INDEX = {
  IDLE: 0,
  AIR_MINUS_CLOSED: 1,
  PRECHARGE_ACTIVE: 2,
  PRECHARGE_COMPLETE: 3,
  HV_ACTIVE: 4
};
const EDGE_IDS = ["edge-0-1", "edge-1-2", "edge-2-3", "edge-3-4"];
const NODE_IDS = ["node-0", "node-1", "node-2", "node-3", "node-4"];

function renderStepper(stage) {
  const isFault = stage === "TIMEOUT_FAULT" || stage === "UNKNOWN_FAULT";
  const activeIndex = isFault ? 2 : (STAGE_NODE_INDEX[stage] ?? 0);

  NODE_IDS.forEach((id, i) => {
    const el = document.getElementById(id);
    el.classList.remove("node-done", "node-active", "node-fault", "node-complete");
    if (i < activeIndex) el.classList.add("node-done");
    else if (i === activeIndex && !isFault) {
      el.classList.add(stage === "HV_ACTIVE" ? "node-complete" : "node-active");
    }
  });

  EDGE_IDS.forEach((id, i) => {
    const el = document.getElementById(id);
    el.classList.remove("edge-done", "edge-active");
    if (i < activeIndex) el.classList.add("edge-done");
    else if (i === activeIndex && !isFault) el.classList.add("edge-active");
  });

  const faultNode = document.getElementById("node-fault");
  const faultEdge = document.getElementById("edge-fault");
  faultNode.classList.toggle("node-fault", isFault);
  faultEdge.classList.toggle("edge-active", isFault);
  faultEdge.classList.toggle("edge-fault", true);
}

// ---------------------------------------------------------------------
// Signal cards
// ---------------------------------------------------------------------
function setSignal(prefix, on, detail) {
  const led = document.getElementById(`${prefix}-led`);
  const state = document.getElementById(`${prefix}-state`);
  const det = document.getElementById(`${prefix}-detail`);
  led.classList.toggle("on", !!on);
  state.textContent = on ? "HIGH" : "LOW";
  if (det && detail !== undefined) det.textContent = detail;
}

// ---------------------------------------------------------------------
// Live status listener
// ---------------------------------------------------------------------
let currentCycleId = null;
let curveRef = null;

const stageLabelEl = document.getElementById("stage-label");
const cycleIdEl = document.getElementById("cycle-id");
const elapsedEl = document.getElementById("elapsed-ms");
const faultBanner = document.getElementById("fault-banner");

db.ref("precharge/live").on("value", (snap) => {
  const d = snap.val();
  if (!d) return;

  stageLabelEl.textContent = (d.stage || "—").replace(/_/g, " ");
  cycleIdEl.textContent = d.cycleId ?? "—";
  elapsedEl.textContent = d.elapsedMs != null ? `${d.elapsedMs} ms` : "—";

  renderStepper(d.stage);

  setSignal("comp", d.comparator?.state, `${d.comparator?.voltage?.toFixed(2) ?? "0.00"} V · ADC ${d.comparator?.adc ?? 0}`);
  setSignal("timer", d.timer?.state, `${d.timer?.voltage?.toFixed(2) ?? "0.00"} V · ADC ${d.timer?.adc ?? 0}`);
  setSignal("and", d.andGate);
  setSignal("pchg", d.precharge);
  setSignal("airm", d.airMinus);
  setSignal("airp", d.airPlus);

  if (d.fault) {
    faultBanner.hidden = false;
    faultBanner.textContent = `FAULT — ${d.faultReason || "unknown"}`;
  } else {
    faultBanner.hidden = true;
  }

  // Switch the curve listener whenever a new cycle starts
  if (d.cycleId != null && d.cycleId !== currentCycleId) {
    currentCycleId = d.cycleId;
    attachCurveListener(currentCycleId);
  }
});

// ---------------------------------------------------------------------
// Live voltage curve chart
// ---------------------------------------------------------------------
const ctx = document.getElementById("curve-chart").getContext("2d");
const curveChart = new Chart(ctx, {
  type: "line",
  data: {
    datasets: [
      {
        label: "Comparator voltage",
        data: [],
        borderColor: "#FF6A1A",
        backgroundColor: "rgba(255,106,26,0.12)",
        fill: true,
        tension: 0.25,
        pointRadius: 0,
        borderWidth: 2
      },
      {
        label: `Threshold (${COMP_THRESHOLD_VOLTS} V)`,
        data: [],
        borderColor: "#57676E",
        borderDash: [4, 4],
        pointRadius: 0,
        borderWidth: 1
      }
    ]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    scales: {
      x: {
        type: "linear",
        title: { display: true, text: "elapsed (ms)", color: "#84939A" },
        ticks: { color: "#84939A" },
        grid: { color: "#1F2A2E" }
      },
      y: {
        min: 0, max: 3.3,
        title: { display: true, text: "volts", color: "#84939A" },
        ticks: { color: "#84939A" },
        grid: { color: "#1F2A2E" }
      }
    },
    plugins: {
      legend: { labels: { color: "#84939A", boxWidth: 14 } }
    }
  }
});

function attachCurveListener(cycleId) {
  if (curveRef) curveRef.off();
  curveRef = db.ref(`precharge/curve/cycle_${cycleId}/points`);
  curveChart.data.datasets[0].data = [];
  curveChart.update();

  curveRef.on("value", (snap) => {
    const pointsObj = snap.val() || {};
    const points = Object.values(pointsObj)
      .map((p) => ({ x: p.t, y: p.v }))
      .sort((a, b) => a.x - b.x);

    curveChart.data.datasets[0].data = points;
    const maxT = points.length ? points[points.length - 1].x : 100;
    curveChart.data.datasets[1].data = [
      { x: 0, y: parseFloat(COMP_THRESHOLD_VOLTS) },
      { x: maxT, y: parseFloat(COMP_THRESHOLD_VOLTS) }
    ];
    curveChart.update();
  });
}

// ---------------------------------------------------------------------
// History log + stats
// ---------------------------------------------------------------------
const historyBody = document.getElementById("history-body");
const statTotal = document.getElementById("stat-total");
const statPassRate = document.getElementById("stat-passrate");
const statAvgDuration = document.getElementById("stat-avgduration");
const statLastFault = document.getElementById("stat-lastfault");

const RESULT_CLASS = {
  PASS: "result-pass",
  FAIL_TIMEOUT: "result-fail",
  FAULT: "result-fault",
  ABORTED: "result-aborted"
};

db.ref("precharge/history").on("value", (snap) => {
  const data = snap.val() || {};
  const cycles = Object.values(data).sort((a, b) => b.cycleId - a.cycleId);

  renderHistoryTable(cycles);
  renderStats(cycles);
});

function renderHistoryTable(cycles) {
  if (!cycles.length) {
    historyBody.innerHTML = `<tr class="empty-row"><td colspan="4">No precharge cycles logged yet.</td></tr>`;
    return;
  }
  historyBody.innerHTML = cycles
    .slice(0, 100)
    .map((c) => {
      const rowClass = RESULT_CLASS[c.result] || "";
      return `<tr class="${rowClass}">
        <td>#${c.cycleId}</td>
        <td>${c.durationMs} ms</td>
        <td>${(c.peakVoltage ?? 0).toFixed(2)} V</td>
        <td class="result">${(c.result || "").replace(/_/g, " ")}</td>
      </tr>`;
    })
    .join("");
}

function renderStats(cycles) {
  const total = cycles.length;
  const passed = cycles.filter((c) => c.result === "PASS");
  const passRate = total ? Math.round((passed.length / total) * 100) : 0;
  const avgDuration = passed.length
    ? Math.round(passed.reduce((s, c) => s + c.durationMs, 0) / passed.length)
    : 0;
  const lastFault = cycles.find((c) => c.result === "FAIL_TIMEOUT" || c.result === "FAULT");

  statTotal.textContent = total;
  statPassRate.textContent = `${passRate}%`;
  statPassRate.className = `stat-value ${passRate >= 90 ? "green" : passRate < 60 ? "red" : ""}`;
  statAvgDuration.textContent = passed.length ? `${avgDuration} ms` : "—";
  statLastFault.textContent = lastFault ? `#${lastFault.cycleId} (${lastFault.result.replace(/_/g, " ")})` : "None";
}
