import fs from "fs-extra";
import path from "path";
import os from "os";

const reportFolder = path.join("playwright-report");
const jsonReportPath = path.join(reportFolder, "report.json");
const outputPath = path.join(reportFolder, "index.html");

function stripAnsi(text) {
  if (!text || typeof text !== "string") return "";
  return text
    .replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\u001b\[\d+m/g, "")
    .replace(/\u001b\[39m/g, "")
    .replace(/\u001b\[32m/g, "")
    .replace(/\u001b\[\d+;\d+m/g, "")
    .trim();
}

function getQueryParams() {
  const params = {};
  const qs = window.location.search.substring(1);
  qs.split("&").forEach(function (pair) {
    if (pair) {
      const [key, value] = pair.split("=");
      params[decodeURIComponent(key)] = decodeURIComponent(value || "");
    }
  });
  return params;
}

function formatDuration(ms) {
  if (!ms || ms < 1000) return `${ms || 0}ms`;
  const seconds = ms / 1000;
  if (seconds <= 100) return `${seconds.toFixed(2)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function safeStringify(value) {
  if (value === null || value === undefined) return "";

  // Handle objects with 'text' property (common in Playwright console logs)
  if (typeof value === "object" && value.text) {
    return stripAnsi(value.text);
  }

  if (typeof value === "string") return stripAnsi(value);

  if (typeof value === "object") {
    try {
      return stripAnsi(JSON.stringify(value, null, 2));
    } catch (e) {
      return stripAnsi(String(value));
    }
  }
  return stripAnsi(String(value));
}

function getTestTitle(test, index, spec = null) {
  // If we have a spec context, use the spec title as the test title
  if (
    spec &&
    spec.title &&
    typeof spec.title === "string" &&
    spec.title.trim()
  ) {
    return spec.title.trim();
  }

  if (!test) return `Test Case ${index + 1}`;

  if (test.title) {
    if (Array.isArray(test.title)) {
      const filtered = test.title.filter((t) => t && t.trim());
      return filtered.length > 0
        ? filtered.join(" › ")
        : `Test Case ${index + 1}`;
    }
    if (typeof test.title === "string" && test.title.trim()) {
      return test.title.trim();
    }
  }

  if (
    test.fullTitle &&
    typeof test.fullTitle === "string" &&
    test.fullTitle.trim()
  ) {
    return test.fullTitle.trim();
  }

  if (test.titlePath && Array.isArray(test.titlePath)) {
    const filtered = test.titlePath.filter((t) => t && t.trim());
    return filtered.length > 0
      ? filtered.join(" › ")
      : `Test Case ${index + 1}`;
  }

  return `Test Case ${index + 1}`;
}

function getSuiteTitle(suite, index) {
  if (!suite) return `Test Scenario ${index + 1}`;

  if (suite.title && typeof suite.title === "string" && suite.title.trim()) {
    return suite.title.trim();
  }

  if (suite.name && typeof suite.name === "string" && suite.name.trim()) {
    return suite.name.trim();
  }

  return `Test Scenario ${index + 1}`;
}

function fixAttachmentPath(attachmentPath, reportFolder) {
  if (!attachmentPath) return "";

  // If it's already a relative path starting with ./ or just a filename, use as is
  if (attachmentPath.startsWith("./") || !attachmentPath.includes("/")) {
    return attachmentPath;
  }

  // For absolute paths, try to make them relative to the report folder
  try {
    const absoluteReportPath = path.resolve(reportFolder);
    const absoluteAttachmentPath = path.resolve(attachmentPath);

    // Get relative path from report folder to attachment
    let relativePath = path.relative(
      absoluteReportPath,
      absoluteAttachmentPath
    );

    // If the relative path goes up directories but the file might be in the same folder
    // as the HTML report, try just using the filename
    if (relativePath.startsWith("..")) {
      const filename = path.basename(attachmentPath);
      // Check if it's in a test-results subfolder pattern
      if (attachmentPath.includes("test-results")) {
        // Keep the test-results structure but make it relative
        const testResultsIndex = attachmentPath.lastIndexOf("test-results");
        relativePath = attachmentPath.substring(testResultsIndex);
      } else {
        // Just use the filename if it exists in the report folder
        relativePath = filename;
      }
    }

    return relativePath;
  } catch (error) {
    console.warn("Could not resolve relative path for:", attachmentPath);
    // Fallback: try to extract just the filename
    return path.basename(attachmentPath);
  }
}

function processTestSteps(result) {
  // Try multiple possible locations for steps
  let steps = null;

  if (result && result.steps && Array.isArray(result.steps)) {
    steps = result.steps;
  } else if (result && result.attachments) {
    // Sometimes steps are embedded in attachments
    const stepAttachment = result.attachments.find(
      (a) => a.name === "steps" || a.contentType === "application/json"
    );
    if (stepAttachment && stepAttachment.body) {
      try {
        const parsedSteps = JSON.parse(stepAttachment.body);
        if (Array.isArray(parsedSteps)) {
          steps = parsedSteps;
        }
      } catch (e) {
        // Silent fail for step parsing
      }
    }
  }

  if (!steps || !Array.isArray(steps)) {
    // Since steps aren't available, show useful alternative information
    let alternativeInfo = [];

    if (result.errors && result.errors.length > 0) {
      alternativeInfo.push(`
        <div class="action-step">
          <div class="step-header">
            <span class="step-title">Test Execution</span>
            <span class="step-duration">${
              result.duration ? formatDuration(result.duration) : "N/A"
            }</span>
          </div>
          <div class="step-error">Test failed with ${
            result.errors.length
          } error(s)</div>
        </div>
      `);
    } else if (result.status === "passed") {
      alternativeInfo.push(`
        <div class="action-step">
          <div class="step-header">
            <span class="step-title">Test Execution</span>
            <span class="step-duration">${
              result.duration ? formatDuration(result.duration) : "N/A"
            }</span>
          </div>
          <div class="step-info">Test completed successfully</div>
        </div>
      `);
    } else {
      alternativeInfo.push(`
        <div class="action-step">
          <div class="step-header">
            <span class="step-title">Test Execution</span>
            <span class="step-duration">${
              result.duration ? formatDuration(result.duration) : "N/A"
            }</span>
          </div>
          <div class="step-info">Test completed with status: ${
            result.status
          }</div>
        </div>
      `);
    }

    if (result.attachments && result.attachments.length > 0) {
      const traceCount = result.attachments.filter((a) =>
        a.name?.includes("trace")
      ).length;
      const screenshotCount = result.attachments.filter((a) =>
        a.name?.includes("screenshot")
      ).length;

      if (traceCount > 0 || screenshotCount > 0) {
        alternativeInfo.push(`
          <div class="action-step">
            <div class="step-header">
              <span class="step-title">Evidence Collected</span>
            </div>
            <div class="step-info">
              ${traceCount > 0 ? `${traceCount} trace file(s) ` : ""}
              ${screenshotCount > 0 ? `${screenshotCount} screenshot(s)` : ""}
              available below
            </div>
          </div>
        `);
      }
    }

    return alternativeInfo.length > 0
      ? alternativeInfo.join("")
      : "<p class='no-data'>Detailed step information not available in JSON report. Check trace files for detailed execution steps.</p>";
  }

  if (steps.length === 0) {
    return "<p class='no-data'>No test actions recorded</p>";
  }

  return steps
    .map((step, stepIdx) => {
      const stepDuration = step.duration ? formatDuration(step.duration) : "";
      const stepTitle =
        step.title || step.category || step.name || `Step ${stepIdx + 1}`;
      const stepError = step.error
        ? stripAnsi(step.error.message || step.error)
        : "";
      const stepLocation = step.location
        ? `${step.location.file || ""}:${step.location.line || ""}`
        : "";

      return `
        <div class="action-step">
          <div class="step-header">
            <span class="step-title">${stepTitle}</span>
            ${
              stepDuration
                ? `<span class="step-duration">${stepDuration}</span>`
                : ""
            }
          </div>
          ${stepError ? `<div class="step-error">${stepError}</div>` : ""}
          ${
            stepLocation
              ? `<div class="step-location">${stepLocation}</div>`
              : ""
          }
        </div>
      `;
    })
    .join("");
}

function processAttachments(result, reportFolder) {
  if (!result || !result.attachments || !Array.isArray(result.attachments)) {
    return { screenshots: [], traces: [], videos: [] };
  }

  const screenshots = result.attachments
    .filter((a) => {
      return (
        a.name?.toLowerCase().includes("screenshot") ||
        a.contentType?.includes("image") ||
        a.name?.match(/\.(png|jpg|jpeg|gif|bmp|webp)$/i)
      );
    })
    .map((attachment) => ({
      ...attachment,
      fixedPath: fixAttachmentPath(attachment.path, reportFolder),
    }));

  const traces = result.attachments
    .filter(
      (a) =>
        a.name?.toLowerCase().includes("trace") ||
        a.contentType?.includes("zip") ||
        a.name?.match(/\.(zip|trace)$/i)
    )
    .map((attachment) => ({
      ...attachment,
      fixedPath: fixAttachmentPath(attachment.path, reportFolder),
    }));

  const videos = result.attachments
    .filter(
      (a) =>
        a.name?.toLowerCase().includes("video") ||
        a.contentType?.includes("video") ||
        a.name?.match(/\.(mp4|webm|avi|mov)$/i)
    )
    .map((attachment) => ({
      ...attachment,
      fixedPath: fixAttachmentPath(attachment.path, reportFolder),
    }));

  return { screenshots, traces, videos };
}

function processConsoleOutput(result) {
  if (!result) return { stdout: "", stderr: "" };

  let stdout = "";
  let stderr = "";

  if (result.stdout) {
    if (Array.isArray(result.stdout)) {
      stdout = result.stdout
        .map((item) => {
          // Handle console log objects with 'text' property
          if (typeof item === "object" && item.text) {
            return stripAnsi(item.text);
          }
          return stripAnsi(safeStringify(item));
        })
        .filter((text) => text && text.trim())
        .join("\n");
    } else {
      stdout = stripAnsi(safeStringify(result.stdout));
    }
  }

  if (result.stderr) {
    if (Array.isArray(result.stderr)) {
      stderr = result.stderr
        .map((item) => {
          // Handle console log objects with 'text' property
          if (typeof item === "object" && item.text) {
            return stripAnsi(item.text);
          }
          return stripAnsi(safeStringify(item));
        })
        .filter((text) => text && text.trim())
        .join("\n");
    } else {
      stderr = stripAnsi(safeStringify(result.stderr));
    }
  }

  if (result.attachments) {
    result.attachments.forEach((attachment) => {
      if (
        attachment.name?.toLowerCase().includes("console") ||
        attachment.name?.toLowerCase().includes("log")
      ) {
        if (attachment.body && typeof attachment.body === "string") {
          stdout += "\n" + stripAnsi(attachment.body);
        }
      }
    });
  }

  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

function debugTestStructure(data) {
  console.log("=== DEBUG: Test Data Structure ===");
  console.log("Root keys:", Object.keys(data));

  if (data.suites && data.suites.length > 0) {
    console.log("Number of suites:", data.suites.length);
    console.log("First suite keys:", Object.keys(data.suites[0]));
    console.log("First suite title:", data.suites[0].title);

    if (data.suites[0].specs && data.suites[0].specs.length > 0) {
      console.log(
        "Number of specs in first suite:",
        data.suites[0].specs.length
      );
      console.log("First spec keys:", Object.keys(data.suites[0].specs[0]));
      console.log("First spec title:", data.suites[0].specs[0].title);

      if (
        data.suites[0].specs[0].tests &&
        data.suites[0].specs[0].tests.length > 0
      ) {
        console.log(
          "Number of tests in first spec:",
          data.suites[0].specs[0].tests.length
        );
        console.log(
          "First test keys:",
          Object.keys(data.suites[0].specs[0].tests[0])
        );
        console.log(
          "First test title:",
          data.suites[0].specs[0].tests[0].title
        );

        if (
          data.suites[0].specs[0].tests[0].results &&
          data.suites[0].specs[0].tests[0].results.length > 0
        ) {
          const result = data.suites[0].specs[0].tests[0].results[0];
          console.log("First result keys:", Object.keys(result));
          console.log("Result status:", result.status);
          console.log("Result duration:", result.duration);
          console.log(
            "Result has attachments:",
            !!result.attachments,
            "Length:",
            result.attachments?.length || 0
          );

          if (result.attachments && result.attachments.length > 0) {
            console.log(
              "Sample attachment keys:",
              Object.keys(result.attachments[0])
            );
            console.log("Sample attachment:", result.attachments[0]);
          }
        }
      }
    }
  }

  // Check alternative structures
  if (data.testResults && data.testResults.length > 0) {
    console.log("Found testResults at root level:", data.testResults.length);
    console.log("First testResult keys:", Object.keys(data.testResults[0]));
  }

  console.log("=== END DEBUG ===");
}

function generateHtml(data) {
  // Add debug info
  debugTestStructure(data);
  const runTimestamp = new Date()
    .toISOString()
    .replace("T", " ")
    .substring(0, 16);
  const runId =
    data.config?.metadata?.testRunId ||
    data.metadata?.testRunId ||
    "TEST_RUN_00001";
  const runBy =
    data.config?.metadata?.triggeredBy ||
    data.metadata?.triggeredBy ||
    os.hostname();

  const suites = data.suites || data.testResults || [];

  // Handle nested suites structure - get only the leaf suites that have specs
  function getLeafSuites(suites) {
    let leafSuites = [];
    for (const suite of suites) {
      if (suite.specs && suite.specs.length > 0) {
        // This suite has specs directly, it's a leaf suite
        leafSuites.push(suite);
      } else if (suite.suites && suite.suites.length > 0) {
        // This suite has nested suites, recurse to find leaf suites
        leafSuites.push(...getLeafSuites(suite.suites));
      }
    }
    return leafSuites;
  }

  const describeBlocks = getLeafSuites(suites);
  const hasDescribe = describeBlocks.length > 0;

  let allTestCases = []; // Flattened list of all test cases for direct filtering
  let totalPassed = 0,
    totalFailed = 0,
    totalSkipped = 0;
  let totalDuration = 0;

  function processTest(
    test,
    suiteIndex = null,
    specIndex = null,
    testIndex = null
  ) {
    const result = test.results?.[0] || test.result || test;
    const status = result.status || result.outcome || "unknown";

    if (status === "passed" || status === "pass") totalPassed++;
    else if (status === "failed" || status === "fail") totalFailed++;
    else totalSkipped++;

    totalDuration += result.duration || 0;

    allTestCases.push({
      suiteIndex,
      specIndex,
      testIndex,
      title: getTestTitle(
        test,
        testIndex,
        specIndex !== null ? describeBlocks[suiteIndex]?.specs[specIndex] : null
      ),
      status,
      duration: result.duration || 0,
      originalTest: test,
    });
  }

  if (hasDescribe) {
    describeBlocks.forEach((suite, suiteIdx) => {
      const specs = suite.specs || suite.tests || [];
      specs.forEach((spec, specIdx) => {
        const tests = spec.tests || [spec];
        tests.forEach((test, testIdx) => {
          processTest(test, suiteIdx, specIdx, testIdx);
        });
      });
    });
  } else {
    // If no describe blocks, treat top-level specs/tests directly
    suites.forEach((suite, suiteIdx) => {
      // suite here is effectively a spec or a direct test
      const tests = suite.tests || [suite]; // if suite is a spec, it has tests; if it's a direct test, it's the test itself
      tests.forEach((test, testIdx) => {
        processTest(test, null, suiteIdx, testIdx); // suiteIdx acts as specIdx here
      });
    });
  }

  const totalTests = totalPassed + totalFailed + totalSkipped;
  const overallColor =
    totalFailed === 0 && totalSkipped === 0 ? "#16a34a" : "#dc2626";

  let scenarioPassedCount = 0,
    scenarioFailedCount = 0,
    scenarioSkippedCount = 0;

  if (hasDescribe) {
    describeBlocks.forEach((suite) => {
      let suiteFailed = false;
      let suiteSkipped = false;
      let hasRun = false;
      const specs = suite.specs || suite.tests || [];
      specs.forEach((spec) => {
        const tests = spec.tests || [spec];
        tests.forEach((test) => {
          const result = test.results?.[0] || test.result || test;
          const status = result.status || result.outcome || "unknown";
          if (status === "failed" || status === "fail") {
            suiteFailed = true;
            hasRun = true;
          } else if (status === "passed" || status === "pass") {
            hasRun = true;
          } else if (status === "skipped" || status === "skip") {
            // If all tests in a suite are skipped, consider the suite skipped
            if (!hasRun) suiteSkipped = true;
          }
        });
      });
      if (suiteFailed) scenarioFailedCount++;
      else if (suiteSkipped && !suiteFailed && !hasRun)
        scenarioSkippedCount++; // A scenario is skipped if all its tests are skipped
      else scenarioPassedCount++; // If no failures and not entirely skipped, it's passed (or partially passed if some were skipped)
    });
  } else {
    // If no describe blocks, the overall counts directly reflect the "Test Blocks" summary
    // Treat the entire run as one "test block" for the bar chart
    scenarioPassedCount = totalFailed === 0 && totalSkipped === 0 ? 1 : 0;
    scenarioFailedCount = totalFailed > 0 ? 1 : 0;
    scenarioSkippedCount =
      totalSkipped > 0 && totalFailed === 0 && totalPassed === 0 ? 1 : 0;
  }

  const overallView = `
    <div id="overall-view">
      <div class="report-header">
        <div class="header-left">
          <h2 class="run-id">${runId}</h2>
          <div class="stats-summary">
            <div class="stat-item">
              <span class="stat-label">Total Test Cases:</span>
              <span class="stat-value" style="color:${overallColor};">${totalPassed}/${totalTests}</span>
            </div>
            <div class="stat-item">
              <span class="stat-label">Duration:</span>
              <span class="stat-value">${formatDuration(totalDuration)}</span>
            </div>
          </div>
          <div class="overall-status ${
            totalFailed === 0 && totalSkipped === 0 ? "passed" : "failed"
          }">
            ${totalFailed === 0 && totalSkipped === 0 ? "PASSED" : "FAILED"}
          </div>
        </div>
        <div class="header-right">
          <div class="run-info">
            <div class="info-item">${runTimestamp}</div>
            <div class="info-item">${runBy}</div>
          </div>
        </div>
      </div>
      <div class="charts-container">
        <div class="chart-card">
          <h3>Test Case Results</h3>
          <canvas id="overall-pie"></canvas>
        </div>
        <div class="chart-card">
          <h3>${hasDescribe ? "Test Scenarios" : "Test Blocks"} Summary</h3>
          <canvas id="overall-bar"></canvas>
        </div>
      </div>
    </div>
  `;

  let listItemsHtml = "";

  if (hasDescribe) {
    describeBlocks.forEach((suite, idx) => {
      const title = getSuiteTitle(suite, idx);
      let passed = 0,
        failed = 0,
        skipped = 0,
        duration = 0;

      const specs = suite.specs || suite.tests || [];
      specs.forEach((spec) => {
        const tests = spec.tests || [spec];
        tests.forEach((test) => {
          const result = test.results?.[0] || test.result || test;
          const status = result.status || result.outcome || "unknown";
          if (status === "passed" || status === "pass") passed++;
          else if (status === "failed" || status === "fail") failed++;
          else skipped++;
          duration += result.duration || 0;
        });
      });

      const status =
        failed > 0
          ? "failed"
          : skipped > 0 && passed === 0
          ? "skipped"
          : "passed";

      listItemsHtml += `
        <div class="list-item ${status}" data-status="${status}" onclick="gotoTestList(${idx})">
          <div class="item-header">
            <h3 class="item-title">${title}</h3>
            <span class="item-status ${status}">${status.toUpperCase()}</span>
          </div>
          <div class="item-stats">
            <span class="stat passed">✓ ${passed}</span>
            <span class="stat failed">✗ ${failed}</span>
            ${
              skipped > 0
                ? `<span class="stat skipped">⊝ ${skipped}</span>`
                : ""
            }
            <span class="stat duration">${formatDuration(duration)}</span>
          </div>
        </div>
      `;
    });
  } else {
    // If no describe blocks, main list directly shows test cases
    allTestCases.forEach((testCase, idx) => {
      listItemsHtml += `
          <div class="list-item ${testCase.status}" data-status="${
        testCase.status
      }" onclick="gotoTestDetail(null, ${testCase.specIndex}, ${
        testCase.testIndex
      })">
            <div class="item-header">
              <h3 class="item-title">${testCase.title}</h3>
              <span class="item-status ${
                testCase.status
              }">${testCase.status.toUpperCase()}</span>
            </div>
            <div class="item-stats">
              <span class="stat duration">${formatDuration(
                testCase.duration
              )}</span>
            </div>
          </div>
        `;
    });
  }

  const mainListView = `
    <div id="main-list" class="list-view">
      <h2 class="section-title">${
        hasDescribe ? "Test Scenarios" : "Test Cases"
      }</h2>
      <div class="filter-buttons" id="main-filter-buttons">
        <button class="filter-btn active" onclick="filterMainList('all', this)">All</button>
        <button class="filter-btn" onclick="filterMainList('passed', this)">Passed</button>
        <button class="filter-btn" onclick="filterMainList('failed', this)">Failed</button>
        <button class="filter-btn" onclick="filterMainList('skipped', this)">Skipped</button>
        <button class="filter-btn clear-filter-btn hidden" onclick="clearMainFilter()">Clear Filter</button>
      </div>
      <div class="list-container" id="main-list-container">
        ${listItemsHtml}
      </div>
    </div>
  `;

  let testListView = `
    <div id="testlist-view" class="hidden">
      <div class="navigation">
        <button class="back-btn" onclick="gotoOverall()">← Back to Overall Report</button>
      </div>
      <div id="testlist-content">
  `;

  if (hasDescribe) {
    describeBlocks.forEach((suite, idx) => {
      let testListHtml = "";
      const specs = suite.specs || suite.tests || [];
      specs.forEach((spec, specIdx) => {
        const tests = spec.tests || [spec];
        tests.forEach((test, tIdx) => {
          const result = test.results?.[0] || test.result || test;
          const status = result.status || result.outcome || "unknown";
          const title = getTestTitle(test, tIdx, spec);
          const duration = result.duration || 0;

          testListHtml += `
            <div class="test-item ${status}" data-status="${status}" onclick="gotoTestDetail(${idx}, ${specIdx}, ${tIdx})">
              <div class="item-header">
                <span class="item-title">${title}</span>
                <span class="item-status ${status}">${status.toUpperCase()}</span>
              </div>
              <div class="item-meta">
                <span class="duration">${formatDuration(duration)}</span>
              </div>
            </div>
          `;
        });
      });

      testListView += `
        <div class="test-list" id="test-list-${idx}" style="display:none;">
          <h2 class="section-title">${getSuiteTitle(
            suite,
            idx
          )} - Test Cases</h2>
          <div class="filter-buttons">
            <button class="filter-btn active" onclick="filterTestList(${idx}, 'all', this)">All</button>
            <button class="filter-btn" onclick="filterTestList(${idx}, 'passed', this)">Passed</button>
            <button class="filter-btn" onclick="filterTestList(${idx}, 'failed', this)">Failed</button>
            <button class="filter-btn" onclick="filterTestList(${idx}, 'skipped', this)">Skipped</button>
          </div>
          <div class="list-container">
            ${testListHtml}
          </div>
        </div>
      `;
    });
  }

  testListView += `</div></div>`;

  let testDetailView = `
    <div id="testdetail-view" class="hidden">
      <div class="navigation">
        <button class="back-btn" onclick="gotoTestListBack()">← Back to Test List</button>
      </div>
      <div id="testdetail-content">
  `;

  if (hasDescribe) {
    describeBlocks.forEach((suite, dIdx) => {
      const specs = suite.specs || suite.tests || [];
      specs.forEach((spec, specIdx) => {
        const tests = spec.tests || [spec];
        tests.forEach((test, tIdx) => {
          const result = test.results?.[0] || test.result || test;
          const status = result.status || result.outcome || "unknown";
          const title = getTestTitle(test, tIdx, spec);
          const duration = result.duration || 0;
          const error = result.error
            ? stripAnsi(result.error.message || result.error)
            : "";

          const { stdout, stderr } = processConsoleOutput(result);
          const { screenshots, traces, videos } = processAttachments(
            result,
            reportFolder
          );
          const actionsHtml = processTestSteps(result);

          testDetailView += `
            <div class="test-detail" id="testdetail-${dIdx}-${specIdx}-${tIdx}" style="display:none;">
              <div class="detail-header">
                <h2 class="test-title">${title}</h2>
                <div class="test-meta">
                  <span class="test-status ${status}">${status.toUpperCase()}</span>
                  <span class="test-duration">${formatDuration(duration)}</span>
                </div>
              </div>

              ${
                error
                  ? `
                <div class="error-section">
                  <h3>Error Details</h3>
                  <pre class="error-message">${error}</pre>
                </div>
              `
                  : ""
              }

              <div class="actions-section">
                <h3>Test Actions</h3>
                <div class="actions-container">
                  ${actionsHtml}
                </div>
              </div>

              ${
                screenshots.length > 0
                  ? `
                <div class="screenshots-section">
                  <h3>Screenshots (${screenshots.length})</h3>
                  <div class="attachments-grid">
                    ${screenshots
                      .map((attachment) => {
                        return `
                      <div class="attachment-item">
                        <img src="${
                          attachment.fixedPath ||
                          attachment.path ||
                          attachment.body
                        }" alt="${
                          attachment.name
                        }" class="screenshot-img" onerror="this.style.display='none'; this.nextElementSibling.innerHTML='Image failed to load: ${
                          attachment.fixedPath || attachment.path
                        }'" />
                        <div class="attachment-info">
                          <span class="attachment-name">${
                            attachment.name
                          }</span>
                          <div class="attachment-path">Original: ${
                            attachment.path
                          }<br>Fixed: ${attachment.fixedPath}</div>
                        </div>
                      </div>
                    `;
                      })
                      .join("")}
                  </div>
                </div>
              `
                  : ""
              }

              ${
                traces.length > 0
                  ? `
                <div class="traces-section">
                  <h3>Traces (${traces.length})</h3>
                  <div class="traces-list">
                    ${traces
                      .map((trace) => {
                        return `
                      <div class="trace-item">
                        <a href="${
                          trace.fixedPath || trace.path || trace.body
                        }" class="trace-link" download="${
                          trace.name
                        }" target="_blank">
                          📁 ${trace.name} (Download)
                        </a>
                        <span class="trace-size">${formatFileSize(
                          trace.body?.length || trace.size || 0
                        )}</span>
                        <div class="trace-path">Original: ${
                          trace.path
                        }<br>Fixed: ${trace.fixedPath}</div>
                      </div>
                    `;
                      })
                      .join("")}
                  </div>
                </div>
              `
                  : ""
              }

              ${
                videos.length > 0
                  ? `
                <div class="videos-section">
                  <h3>Videos</h3>
                  <div class="videos-list">
                    ${videos
                      .map(
                        (video) => `
                      <div class="video-item">
                        <video controls class="test-video">
                          <source src="${
                            video.fixedPath || video.path
                          }" type="${video.contentType || "video/mp4"}">
                          Your browser does not support the video tag.
                        </video>
                        <div class="video-info">${video.name}</div>
                      </div>
                    `
                      )
                      .join("")}
                  </div>
                </div>
              `
                  : ""
              }

              ${
                stdout || stderr
                  ? `
                <div class="console-section">
                  <h3>Console Output</h3>
                  ${
                    stdout
                      ? `
                    <div class="console-output">
                      <h4>Standard Output</h4>
                      <pre class="console-content stdout">${stdout}</pre>
                    </div>
                  `
                      : ""
                  }
                  ${
                    stderr
                      ? `
                    <div class="console-output">
                      <h4>Standard Error</h4>
                      <pre class="console-content stderr">${stderr}</pre>
                    </div>
                  `
                      : ""
                  }
                </div>
              `
                  : ""
              }
            </div>
          `;
        });
      });
    });
  } else {
    // Directly process allTestCases for detail view if no describe blocks
    allTestCases.forEach((testCase, tIdx) => {
      const result =
        testCase.originalTest.results?.[0] ||
        testCase.originalTest.result ||
        testCase.originalTest;
      const status = testCase.status;
      const title = testCase.title;
      const duration = testCase.duration;
      const error = result.error
        ? stripAnsi(result.error.message || result.error)
        : "";

      const { stdout, stderr } = processConsoleOutput(result);
      const { screenshots, traces, videos } = processAttachments(
        result,
        reportFolder
      );
      const actionsHtml = processTestSteps(result);

      testDetailView += `
          <div class="test-detail" id="testdetail-null-${testCase.specIndex}-${
        testCase.testIndex
      }" style="display:none;">
            <div class="detail-header">
              <h2 class="test-title">${title}</h2>
              <div class="test-meta">
                <span class="test-status ${status}">${status.toUpperCase()}</span>
                <span class="test-duration">${formatDuration(duration)}</span>
              </div>
            </div>

            ${
              error
                ? `
              <div class="error-section">
                <h3>Error Details</h3>
                <pre class="error-message">${error}</pre>
              </div>
            `
                : ""
            }

            <div class="actions-section">
              <h3>Test Actions</h3>
              <div class="actions-container">
                ${actionsHtml}
              </div>
            </div>

            ${
              screenshots.length > 0
                ? `
              <div class="screenshots-section">
                <h3>Screenshots</h3>
                <div class="attachments-grid">
                  ${screenshots
                    .map(
                      (attachment) => `
                    <div class="attachment-item">
                      <img src="${
                        attachment.fixedPath || attachment.path
                      }" alt="${attachment.name}" class="screenshot-img" />
                      <div class="attachment-info">
                        <span class="attachment-name">${attachment.name}</span>
                      </div>
                    </div>
                  `
                    )
                    .join("")}
                </div>
              </div>
            `
                : ""
            }

            ${
              traces.length > 0
                ? `
              <div class="traces-section">
                <h3>Traces</h3>
                <div class="traces-list">
                  ${traces
                    .map(
                      (trace) => `
                    <div class="trace-item">
                      <a href="${
                        trace.fixedPath || trace.path
                      }" class="trace-link" download="${trace.name}">
                        📁 ${trace.name} (Download)
                      </a>
                      <span class="trace-size">${formatFileSize(
                        trace.body?.length || 0
                      )}</span>
                    </div>
                  `
                    )
                    .join("")}
                </div>
              </div>
            `
                : ""
            }

            ${
              videos.length > 0
                ? `
              <div class="videos-section">
                <h3>Videos</h3>
                <div class="videos-list">
                  ${videos
                    .map(
                      (video) => `
                    <div class="video-item">
                      <video controls class="test-video">
                        <source src="${video.fixedPath || video.path}" type="${
                        video.contentType || "video/mp4"
                      }">
                        Your browser does not support the video tag.
                      </video>
                      <div class="video-info">${video.name}</div>
                    </div>
                  `
                    )
                    .join("")}
                </div>
              </div>
            `
                : ""
            }

            ${
              stdout || stderr
                ? `
              <div class="console-section">
                <h3>Console Output</h3>
                ${
                  stdout
                    ? `
                  <div class="console-output">
                    <h4>Standard Output</h4>
                    <pre class="console-content stdout">${stdout}</pre>
                  </div>
                `
                    : ""
                }
                ${
                  stderr
                    ? `
                  <div class="console-output">
                    <h4>Standard Error</h4>
                    <pre class="console-content stderr">${stderr}</pre>
                  </div>
                `
                    : ""
                }
              </div>
            `
                : ""
            }
          </div>
        `;
    });
  }

  testDetailView += `</div></div>`;

  const finalHtml = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Playwright Test Report</title>
      <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        
        body { 
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: #0d1117; 
          color: #e6edf3; 
          line-height: 1.5;
        }
        
        .container { 
          max-width: 1400px; 
          margin: 0 auto; 
          padding: 20px;
        }
        
        h1 { 
          text-align: center; 
          margin-bottom: 30px; 
          font-size: 2.5rem; 
          color: #f0f6fc;
          font-weight: 600;
        }
        
        .report-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          background: #161b22;
          border: 1px solid #30363d;
          border-radius: 12px;
          padding: 24px;
          margin-bottom: 24px;
        }
        
        .header-left .run-id {
          font-size: 2rem;
          font-weight: 700;
          color: #f0f6fc;
          margin-bottom: 12px;
        }
        
        .stats-summary {
          display: flex;
          gap: 24px;
          margin-bottom: 16px;
        }
        
        .stat-item {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        
        .stat-label {
          font-size: 0.875rem;
          color: #8b949e;
          font-weight: 500;
        }
        
        .stat-value {
          font-size: 1.25rem;
          font-weight: 600;
        }
        
        .overall-status {
          padding: 8px 16px;
          border-radius: 6px;
          font-weight: 700;
          font-size: 1rem;
          text-align: center;
          min-width: 100px;
        }
        
        .overall-status.passed {
          background: #238636;
          color: white;
        }
        
        .overall-status.failed {
          background: #da3633;
          color: white;
        }
        
        .filter-buttons {
          display: flex;
          gap: 8px;
          margin-bottom: 16px;
          flex-wrap: wrap;
        }
        
        .filter-btn {
          background: #21262d;
          color: #e6edf3;
          border: 1px solid #30363d;
          border-radius: 6px;
          padding: 8px 16px;
          cursor: pointer;
          font-size: 0.875rem;
          font-weight: 500;
          transition: all 0.2s ease;
        }
        
        .filter-btn:hover {
          background: #30363d;
          border-color: #58a6ff;
        }
        
        .filter-btn.active {
          background: #58a6ff;
          color: white;
          border-color: #58a6ff;
        }

        .filter-btn.clear-filter-btn {
            background: #f85149;
            border-color: #f85149;
        }
        .filter-btn.clear-filter-btn:hover {
            background: #da3633;
            border-color: #da3633;
        }
        
        .header-right .run-info {
          text-align: right;
        }
        
        .info-item {
          color: #8b949e;
          font-size: 0.875rem;
          margin-bottom: 4px;
        }
        
        .charts-container {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
          gap: 24px;
          margin-bottom: 32px;
        }
        
        .chart-card {
          background: #161b22;
          border: 1px solid #30363d;
          border-radius: 12px;
          padding: 20px;
          height: 400px;
        }
        
        .chart-card h3 {
          margin-bottom: 16px;
          color: #f0f6fc;
          font-size: 1.125rem;
          font-weight: 600;
        }
        
        .list-view {
          background: #161b22;
          border: 1px solid #30363d;
          border-radius: 12px;
          padding: 24px;
          margin-bottom: 24px;
        }
        
        .section-title {
          font-size: 1.5rem;
          font-weight: 600;
          color: #f0f6fc;
          margin-bottom: 20px;
        }
        
        .list-container {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        
        .list-item, .test-item {
          background: #0d1117;
          border: 1px solid #30363d;
          border-radius: 8px;
          padding: 16px;
          cursor: pointer;
          transition: all 0.2s ease;
        }
        
        .list-item:hover, .test-item:hover {
          border-color: #58a6ff;
          transform: translateY(-1px);
        }
        
        .list-item.failed, .test-item.failed {
          border-left: 4px solid #da3633;
        }
        
        .list-item.passed, .test-item.passed {
          border-left: 4px solid #238636;
        }
        
        .list-item.skipped, .test-item.skipped {
          border-left: 4px solid #f97316; /* Orange for skipped */
        }
        
        .item-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          margin-bottom: 8px;
        }
        
        .item-title {
          font-size: 1rem;
          font-weight: 600;
          color: #f0f6fc;
          flex: 1;
          margin-right: 12px;
        }
        
        .item-status {
          padding: 4px 8px;
          border-radius: 4px;
          font-size: 0.75rem;
          font-weight: 700;
          text-transform: uppercase;
          white-space: nowrap;
        }
        
        .item-status.passed {
          background: #238636;
          color: white;
        }
        
        .item-status.failed {
          background: #da3633;
          color: white;
        }
        
        .item-status.skipped {
          background: #f97316; /* Orange for skipped */
          color: white;
        }
        
        .item-stats, .item-meta {
          display: flex;
          gap: 16px;
          font-size: 0.875rem;
          color: #8b949e;
        }
        
        .stat.passed { color: #238636; }
        .stat.failed { color: #da3633; }
        .stat.skipped { color: #f97316; } /* Orange for skipped */
        .stat.duration { color: #8b949e; }
        
        .suite-name {
          color: #58a6ff !important;
          font-weight: 500;
        }
        
        .view-toggle {
          background: #238636 !important;
          color: white !important;
          border-color: #238636 !important;
        }
        
        .view-toggle:hover {
          background: #2ea043 !important;
        }
        
        .clear-filter-btn {
          background: #f85149 !important;
          color: white !important;
          border-color: #f85149 !important;
        }
        
        .clear-filter-btn:hover {
          background: #da3633 !important;
        }
        
        .navigation {
          margin-bottom: 24px;
        }
        
        .back-btn {
          background: #238636;
          color: white;
          border: none;
          border-radius: 6px;
          padding: 10px 16px;
          cursor: pointer;
          font-size: 0.875rem;
          font-weight: 500;
          transition: background-color 0.2s ease;
        }
        
        .back-btn:hover {
          background: #2ea043;
        }
        
        .test-detail {
          background: #161b22;
          border: 1px solid #30363d;
          border-radius: 12px;
          padding: 24px;
          margin-bottom: 24px;
        }
        
        .detail-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          margin-bottom: 24px;
          padding-bottom: 16px;
          border-bottom: 1px solid #30363d;
        }
        
        .test-title {
          font-size: 1.5rem;
          font-weight: 600;
          color: #f0f6fc;
          flex: 1;
          margin-right: 16px;
        }
        
        .test-meta {
          display: flex;
          flex-direction: column;
          gap: 8px;
          align-items: flex-end;
        }
        
        .test-status {
          padding: 6px 12px;
          border-radius: 6px;
          font-size: 0.875rem;
          font-weight: 700;
          text-transform: uppercase;
        }
        
        .test-status.passed {
          background: #238636;
          color: white;
        }
        
        .test-status.failed {
          background: #da3633;
          color: white;
        }
        
        .test-status.skipped {
          background: #f97316; /* Orange for skipped */
          color: white;
        }
        
        .test-duration {
          font-size: 0.875rem;
          color: #8b949e;
          font-weight: 500;
        }
        
        .error-section, .actions-section, .screenshots-section, 
        .traces-section, .videos-section, .console-section {
          margin-bottom: 32px;
        }
        
        .error-section h3, .actions-section h3, .screenshots-section h3,
        .traces-section h3, .videos-section h3, .console-section h3 {
          font-size: 1.125rem;
          font-weight: 600;
          color: #f0f6fc;
          margin-bottom: 16px;
        }
        
        .error-message {
          background: #0d1117;
          border: 1px solid #da3633;
          border-radius: 6px;
          padding: 16px;
          color: #ffa198;
          font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
          font-size: 0.875rem;
          line-height: 1.45;
          white-space: pre-wrap;
          overflow-x: auto;
        }
        
        .actions-container {
          background: #0d1117;
          border: 1px solid #30363d;
          border-radius: 6px;
          padding: 16px;
        }
        
        .action-step {
          padding: 12px 0;
          border-bottom: 1px solid #21262d;
        }
        
        .action-step:last-child {
          border-bottom: none;
        }
        
        .step-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 4px;
        }
        
        .step-title {
          font-size: 0.875rem;
          color: #e6edf3;
          font-weight: 500;
        }
        
        .step-duration {
          font-size: 0.75rem;
          color: #8b949e;
        }
        
        .step-location {
          font-size: 0.75rem;
          color: #8b949e;
          font-style: italic;
          margin-top: 4px;
        }
        
        .step-error {
          background: #0d1117;
          border: 1px solid #da3633;
          border-radius: 4px;
          padding: 8px;
          margin-top: 8px;
          color: #ffa198;
          font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
          font-size: 0.8rem;
        }
        
        .step-info {
          color: #8b949e;
          font-size: 0.8rem;
          margin-top: 4px;
          font-style: italic;
        }
        
        .no-data {
          color: #8b949e;
          font-style: italic;
          text-align: center;
          padding: 20px;
        }
        
        .attachments-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
          gap: 16px;
        }
        
        .attachment-item {
          background: #0d1117;
          border: 1px solid #30363d;
          border-radius: 8px;
          padding: 12px;
          text-align: center;
        }
        
        .screenshot-img {
          max-width: 100%;
          height: auto;
          border-radius: 4px;
          margin-bottom: 8px;
          cursor: pointer;
          transition: transform 0.2s ease;
        }
        
        .screenshot-img:hover {
          transform: scale(1.05);
        }
        
        .attachment-info {
          font-size: 0.875rem;
          color: #8b949e;
        }
        
        .attachment-path, .trace-path {
          font-size: 0.75rem;
          color: #58a6ff;
          margin-top: 4px;
          word-break: break-all;
        }
        
        .traces-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        
        .trace-item {
          background: #0d1117;
          border: 1px solid #30363d;
          border-radius: 6px;
          padding: 12px;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        
        .trace-link {
          color: #58a6ff;
          text-decoration: none;
          font-weight: 500;
        }
        
        .trace-link:hover {
          text-decoration: underline;
        }
        
        .trace-size {
          font-size: 0.75rem;
          color: #8b949e;
        }
        
        .videos-list {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        
        .video-item {
          background: #0d1117;
          border: 1px solid #30363d;
          border-radius: 8px;
          padding: 16px;
        }
        
        .test-video {
          width: 100%;
          max-width: 800px;
          height: auto;
          border-radius: 4px;
          margin-bottom: 8px;
        }
        
        .video-info {
          font-size: 0.875rem;
          color: #8b949e;
          font-weight: 500;
        }
        
        .console-output {
          margin-bottom: 16px;
        }
        
        .console-output h4 {
          font-size: 1rem;
          color: #f0f6fc;
          margin-bottom: 8px;
        }
        
        .console-content {
          background: #0d1117;
          border: 1px solid #30363d;
          border-radius: 6px;
          padding: 12px;
          font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
          font-size: 0.8rem;
          line-height: 1.4;
          white-space: pre-wrap;
          overflow-x: auto;
          max-height: 300px;
          overflow-y: auto;
        }
        
        .console-content.stdout {
          color: #e6edf3;
        }
        
        .console-content.stderr {
          color: #ffa198;
          border-color: #da3633;
        }
        
        .hidden { 
          display: none; 
        }
        
        @media (max-width: 768px) {
          .container {
            padding: 16px;
          }
          
          .report-header {
            flex-direction: column;
            gap: 16px;
          }
          
          .header-right {
            align-self: flex-start;
          }
          
          .stats-summary {
            flex-direction: column;
            gap: 12px;
          }
          
          .charts-container {
            grid-template-columns: 1fr;
          }
          
          .item-header {
            flex-direction: column;
            align-items: flex-start;
            gap: 8px;
          }
          
          .detail-header {
            flex-direction: column;
            gap: 16px;
          }
          
          .test-meta {
            align-items: flex-start;
            flex-direction: row;
            gap: 12px;
          }
          
          .filter-buttons {
            flex-wrap: wrap;
          }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>Playwright Test Report</h1>
        ${overallView}
        ${mainListView}
        ${testListView}
        ${testDetailView}
      </div>
      <script>
        const allTestCasesData = ${JSON.stringify(
          allTestCases
        )}; // Pass flattened data to client-side
        const describeBlocksData = ${JSON.stringify(
          describeBlocks
        )}; // Pass suites data
        const hasDescribe = ${hasDescribe};

        function getQueryParams() {
          const params = {};
          const qs = window.location.search.substring(1);
          qs.split('&').forEach(function(pair) {
            if(pair) {
              const [key, value] = pair.split('=');
              params[decodeURIComponent(key)] = decodeURIComponent(value || '');
            }
          });
          return params;
        }
        
        function filterMainList(status, clickedButton = null) {
          const filterBtns = document.querySelectorAll('#main-filter-buttons .filter-btn');
          filterBtns.forEach(btn => btn.classList.remove('active'));
          
          if (clickedButton) {
            clickedButton.classList.add('active');
          } else { // If called programmatically (e.g., from chart click)
            const targetBtn = Array.from(filterBtns).find(btn => btn.textContent.toLowerCase() === status);
            if (targetBtn) {
              targetBtn.classList.add('active');
            }
          }

          const clearBtn = document.querySelector('#main-filter-buttons .clear-filter-btn');
          if (status === 'all') {
            clearBtn.classList.add('hidden');
          } else {
            clearBtn.classList.remove('hidden');
          }
          
          const listItems = document.querySelectorAll('#main-list-container .list-item');
          listItems.forEach(item => {
            if (status === 'all' || item.dataset.status === status) {
              item.style.display = 'block';
            } else {
              item.style.display = 'none';
            }
          });
        }

        function clearMainFilter() {
            filterMainList('all'); // Reset to show all
        }
        
        function filterTestList(descIndex, status, clickedButton = null) {
          const filterBtns = document.querySelectorAll(\`#test-list-\${descIndex} .filter-btn\`);
          filterBtns.forEach(btn => btn.classList.remove('active'));
          
          if (clickedButton) {
            clickedButton.classList.add('active');
          } else { // If called programmatically (e.g., from chart click)
            const targetBtn = Array.from(filterBtns).find(btn => btn.textContent.toLowerCase() === status);
            if (targetBtn) {
              targetBtn.classList.add('active');
            }
          }

          const testItems = document.querySelectorAll(\`#test-list-\${descIndex} .test-item\`);
          testItems.forEach(item => {
            if (status === 'all' || item.dataset.status === status) {
              item.style.display = 'block';
            } else {
              item.style.display = 'none';
            }
          });
        }
        
        function gotoOverall() {
          window.location.href = window.location.pathname;
        }
        
        function gotoTestList(descIndex, filterStatus = 'all') {
          let url = window.location.pathname + "?mode=testlist";
          if(descIndex !== null) {
            url += "&desc=" + descIndex;
          }
          if (filterStatus !== 'all') {
            url += "&filter=" + filterStatus;
          }
          window.location.href = url;
        }
        
        function gotoTestDetail(descIndex, specIndex, testIndex) {
          let url = window.location.pathname + "?mode=testdetail";
          if(descIndex !== null) {
            url += "&desc=" + descIndex;
          }
          url += "&spec=" + specIndex + "&test=" + testIndex;
          window.location.href = url;
        }
        
        function gotoTestListBack() {
          const params = getQueryParams();
          if(hasDescribe && params.desc !== undefined) {
            window.location.href = window.location.pathname + "?mode=testlist&desc=" + params.desc;
          } else {
            window.location.href = window.location.pathname; // Go back to overall view if no specific test list context
          }
        }
        
        window.onload = function() {
          const params = getQueryParams();
          
          const pieCtx = document.getElementById('overall-pie');
          if (pieCtx) {
            const pieChart = new Chart(pieCtx, {
              type: 'doughnut',
              data: {
                labels: ['Passed', 'Failed'${
                  totalSkipped > 0 ? ", 'Skipped'" : ""
                }],
                datasets: [{
                  data: [${totalPassed}, ${totalFailed}${
    totalSkipped > 0 ? `, ${totalSkipped}` : ""
  }],
                  backgroundColor: ['#238636', '#da3633'${
                    totalSkipped > 0 ? ", '#f97316'" : ""
                  }],
                  borderWidth: 2,
                  borderColor: '#30363d'
                }]
              },
              options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                  legend: {
                    position: 'bottom',
                    labels: {
                      color: '#e6edf3',
                      padding: 20,
                      font: {
                        size: 12
                      }
                    }
                  },
                  title: {
                    display: true,
                    text: 'Test Case Results Distribution',
                    color: '#f0f6fc',
                    font: {
                      size: 14,
                      weight: 600
                    }
                  }
                },
                onClick: (event, elements) => {
                    if (elements.length > 0) {
                        const clickedElement = elements[0];
                        const label = pieChart.data.labels[clickedElement.index];
                        let status = '';
                        if (label === 'Passed') status = 'passed';
                        else if (label === 'Failed') status = 'failed';
                        else if (label === 'Skipped') status = 'skipped';
                        
                        if (hasDescribe) {
                            // Pie chart click will always go to the main list and filter
                            gotoOverall(); // Go back to overall first to clear existing view
                            setTimeout(() => { // Small delay to allow view transition
                                filterMainList(status);
                            }, 100); 
                        } else {
                            // If no describe blocks, filter the existing main list (which shows test cases)
                            filterMainList(status);
                        }
                    }
                }
              }
            });
          }
          
          const barCtx = document.getElementById('overall-bar');
          if (barCtx) {
            const barChart = new Chart(barCtx, {
              type: 'bar',
              data: {
                labels: ['Passed', 'Failed'${
                  scenarioSkippedCount > 0 ? ", 'Skipped'" : ""
                }],
                datasets: [{
                  label: hasDescribe ? 'Test Scenarios' : 'Test Blocks',
                  data: [${scenarioPassedCount}, ${scenarioFailedCount}${
    scenarioSkippedCount > 0 ? `, ${scenarioSkippedCount}` : ""
  }],
                  backgroundColor: ['#238636', '#da3633'${
                    scenarioSkippedCount > 0 ? ", '#f97316'" : ""
                  }],
                  borderColor: ['#2ea043', '#f85149'${
                    scenarioSkippedCount > 0 ? ", '#e0660f'" : ""
                  }],
                  borderWidth: 1,
                  maxBarThickness: 60
                }]
              },
              options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                  legend: {
                    display: false
                  },
                  title: {
                    display: true,
                    text: hasDescribe ? 'Test Scenarios Status' : 'Test Blocks Status',
                    color: '#f0f6fc',
                    font: {
                      size: 14,
                      weight: 600
                    }
                  }
                },
                scales: {
                  y: {
                    beginAtZero: true,
                    ticks: {
                      precision: 0,
                      color: '#8b949e'
                    },
                    grid: {
                      color: '#30363d'
                    }
                  },
                  x: {
                    ticks: {
                      color: '#8b949e'
                    },
                    grid: {
                      color: '#30363d'
                    }
                  }
                },
                onClick: (event, elements) => {
                    if (elements.length > 0) {
                        const clickedElement = elements[0];
                        const label = barChart.data.labels[clickedElement.index];
                        let status = '';
                        if (label === 'Passed') status = 'passed';
                        else if (label === 'Failed') status = 'failed';
                        else if (label === 'Skipped') status = 'skipped';

                        // For bar chart, always go to overall view and apply filter on main list
                        gotoOverall(); 
                        setTimeout(() => { // Small delay to allow view transition
                            filterMainList(status);
                        }, 100);
                    }
                }
              }
            });
          }
          
          const overallView = document.getElementById("overall-view");
          const mainList = document.getElementById("main-list");
          const testlistView = document.getElementById("testlist-view");
          const testdetailView = document.getElementById("testdetail-view");
          
          [overallView, mainList, testlistView, testdetailView].forEach(el => {
            if (el) el.classList.add("hidden");
          });
          
          if (!params.mode) {
            if (overallView) overallView.classList.remove("hidden");
            if (mainList) mainList.classList.remove("hidden");
            // Apply initial filter if any passed from chart click
            if (params.filter) {
                filterMainList(params.filter);
            } else {
                filterMainList('all'); // Default to all if no filter
            }
          } else if (params.mode === "testlist") {
            if (testlistView) testlistView.classList.remove("hidden");
            
            const lists = document.getElementsByClassName("test-list");
            Array.from(lists).forEach(list => list.style.display = "none");
            
            const targetListId = params.desc !== undefined ? "test-list-" + params.desc : "test-list-0";
            const targetList = document.getElementById(targetListId);
            if (targetList) {
                targetList.style.display = "block";
                // Apply filter if passed from URL
                if (params.filter) {
                    filterTestList(params.desc, params.filter);
                } else {
                    filterTestList(params.desc, 'all'); // Default to all
                }
            }
          } else if (params.mode === "testdetail") {
            if (testdetailView) testdetailView.classList.remove("hidden");
            
            let targetDetailId;
            if (params.desc !== undefined) {
              targetDetailId = "testdetail-" + params.desc + "-" + params.spec + "-" + params.test;
            } else {
              targetDetailId = "testdetail-null-" + params.spec + "-" + params.test;
            }
            
            const targetDetail = document.getElementById(targetDetailId);
            if (targetDetail) targetDetail.style.display = "block";
          }
          
          document.addEventListener('click', function(e) {
            if (e.target.classList.contains('screenshot-img')) {
              const modal = document.createElement('div');
              modal.style.cssText = \`
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0,0,0,0.9);
                display: flex;
                justify-content: center;
                align-items: center;
                z-index: 1000;
                cursor: pointer;
              \`;
              
              const img = document.createElement('img');
              img.src = e.target.src;
              img.style.cssText = \`
                max-width: 90%;
                max-height: 90%;
                border-radius: 8px;
              \`;
              
              modal.appendChild(img);
              document.body.appendChild(modal);
              
              modal.addEventListener('click', function() {
                document.body.removeChild(modal);
              });
            }
          });
        };
      </script>
    </body>
    </html>
  `;

  return finalHtml;
}

async function generateReport() {
  try {
    if (!fs.existsSync(reportFolder)) {
      fs.mkdirSync(reportFolder, { recursive: true });
    }

    if (!fs.existsSync(jsonReportPath)) {
      console.error("❌ JSON report file not found at", jsonReportPath);
      process.exit(1);
    }

    console.log("📊 Reading JSON report...");
    const data = fs.readJsonSync(jsonReportPath);

    console.log("🎨 Generating HTML report...");
    const html = generateHtml(data);

    await fs.outputFile(outputPath, html);
    console.log(`✅ Report generated successfully at ${outputPath}`);

    // Try to open the report, but don't fail if 'open' package is not available
    try {
      const open = await import("open");
      if (open?.default) {
        await open.default(outputPath);
        console.log("🌐 Report opened in browser");
      }
    } catch (error) {
      console.log(
        "💡 To automatically open the report, install: npm install open"
      );
      console.log(`📂 Manually open: ${outputPath}`);
    }
  } catch (error) {
    console.error("❌ Error generating report:", error.message);
    process.exit(1);
  }
}

generateReport();
