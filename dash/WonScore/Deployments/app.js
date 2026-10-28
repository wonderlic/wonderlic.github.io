const _currentVersion = "20261028.01";
let _newVersion = _currentVersion;
let _mqttCreds;
let _shouldReconnect;

const _changes = {};
const _jobs = {};
let _renderTimeout;
let _filter = "";
let _checking;
let _lastCheckedOn;
let _refreshRate;
let _isStale = false;
let _enableRefreshAt;
//let _enableBoostAt;

function onMQTTConnected() {
  if (_shouldReconnect) {
    setStatus("Connected");
    loadMainView();
    localStorage.setItem("autoConnect", true);

    MQTT_Subscribe("dashboard/WonScore/Deployments/version", (version) => {
      if (_newVersion !== _currentVersion) return;
      if (parseFloat(version) > parseFloat(_currentVersion)) {
        _newVersion = version;
        renderChanges();
        loadNewVersionView();
      }
    });

    MQTT_Subscribe("dashboard/WonScore/Deployments/ReleaseNotes/+", (changes, [version]) => {
      if (parseFloat(version) > parseFloat(_currentVersion)) { 
        _changes[version] = changes;
        renderChanges();
      }
    });

    MQTT_Subscribe("AWS-WonScore/ECS/services/checking", (ts) => {
      if (_newVersion !== _currentVersion) return;
      if (ts === "") {
        _checking = false;
      } else {
        _checking = timestampToDate(ts);
        $("#lastChecked").text("checking now...");
      }
    });

    MQTT_Subscribe("AWS-WonScore/ECS/services/lastCheckedOn", (ts) => {
      if (_newVersion !== _currentVersion) return;
      _lastCheckedOn = timestampToDate(ts);
      //_enableRefreshAt = new Date(_lastCheckedOn.getTime() + 5000);
      const seconds = getDateDiffSeconds(_lastCheckedOn, new Date());
      $("#lastChecked").text(`${getTimespanString(seconds)} ago`);
    });

    MQTT_Subscribe("AWS-WonScore/ECS/services/refreshRate", (rate) => {
      if (_newVersion !== _currentVersion) return;
      const refreshRate = parseInt(rate);
      _refreshRate = refreshRate;
      $("#refreshRate").text(getTimespanString(refreshRate));
	    if (refreshRate === 10) {
        $("#btnBoost").attr('disabled','disabled');
      } else {
        $("#btnBoost").removeAttr('disabled');
      }
    });

    MQTT_Subscribe("AWS-WonScore/ECS/services/+/+/deploymentStatus", (status, [envName, jobName]) => {
      if (_newVersion !== _currentVersion) return;
      //console.log(envName, jobName, status);
      setJobField(envName, jobName, "deployStatus", status);
      renderMainView();
    });

    MQTT_Subscribe("Jenkins/+/+/status", (status, [envName, jobName]) => {
      if (_newVersion !== _currentVersion) return;
      //console.log(envName, jobName, status);
      setJobField(envName, jobName, "buildStatus", status);
      renderMainView();
    });

    MQTT_Subscribe("Jenkins/+/+/inQueueSince", (ts, [envName, jobName]) => {
      if (_newVersion !== _currentVersion) return;
      //console.log(envName, jobName, ts);
      setJobField(envName, jobName, "inQueueSince", ts === "" ? ts : timestampToDate(ts));
      renderMainView();
    });

  } else {
    MQTT_Disconnect();
  }
}

function onMQTTConnectionFailure(reason) {
  if (_shouldReconnect) {
    setStatus("Connection failed: " + reason.errorMessage);
    setTimeout(MQTT_Connect, 2000);
  } else {
    setStatus("Not connected");
  }
  localStorage.setItem("autoConnect", false);
}

function onMQTTConnectionLost(reason) {
  if (_shouldReconnect) {
    setStatus("Connection lost: " + reason.errorMessage);
    setTimeout(MQTT_Connect, 2000);
  } else {
    setStatus("Not connected");
  }
}

function setJobField(envName, jobName, key, value) {
  const job = _jobs[jobName] || {alpha: {}, beta: {}, prod: {}};
  const env = job[envName] || {};
  if (value === "") {
    delete env[key];
  } else {
    env[key] = value;
  }
  job[envName] = env;
  // TODO: delete empty jobs?
  _jobs[jobName] = job;
}

function renderChanges() {
  let html = "";
  for (const v of Object.keys(_changes).sort((a,b) => { return parseFloat(b) - parseFloat(a); })) {
    if (parseFloat(v) > parseFloat(_newVersion)) continue;
    html += `<div><label>${escapeHtml(v)}:</label></div><ul>`;
    for (const change of _changes[v].replaceAll("\r", "").split("\n")) {
      if (change === "") continue;
      html += `<li>${escapeHtml(change)}</li>`;
    }
    html += `</ul>`;
  }
  $("#newVersionChanges").html(html);
}

function renderMainView() {
  if (_renderTimeout) clearTimeout(_renderTimeout);
  _renderTimeout = setTimeout(function() {
    renderOverallStatuses();
    renderJobs();
  }, 100);  
}

function renderOverallStatuses() {
  const jenkinsStatuses = [];
  const deployStatuses = [];

  for (const jobName of Object.keys(_jobs).sort()) {
    const job = _jobs[jobName];
    for (const envName of Object.keys(job)) {
      const env = job[envName];
      jenkinsStatuses.push(getJenkinsStatus(env));
      deployStatuses.push(env.deployStatus);
    }
  }

  const buildStatus = getHighestPriorityStatus(...jenkinsStatuses, "SUCCESS");
  const deployStatus = getHighestPriorityStatus(...deployStatuses, "COMPLETED");
  const overallStatus = getHighestPriorityStatus(buildStatus, deployStatus);

  $('link[rel="icon"]').attr('href', `icons/${_isStale ? "unknown.png" : getStatusIcon(overallStatus)}`);
  $("#buildStatus").text(getStatusText(buildStatus)).removeClass("success queued building unknown failed").addClass(getStatusClass(buildStatus));
  $("#deployStatus").text(getStatusText(deployStatus)).removeClass("success deploying failed").addClass(getStatusClass(deployStatus));
}

function renderJobs() {
  let html = "";
  for (const jobName of Object.keys(_jobs).sort()) {
	if (_filter !== "")	{
    if (!jobName.includes(_filter)) continue;
	}
	const job = _jobs[jobName];
    html += `<tr><td class="${getJobType(jobName)} icon">${escapeHtml(jobName)}</td>${buildJobEnvStatus(job.alpha)}${buildJobEnvStatus(job.beta)}${buildJobEnvStatus(job.prod)}</tr>`;
  }
  if (html == "") {
    html = `<tr><td colspan="7">No results found.</tr>`;
  }
  $("#tblJobs > tbody").html(html); 
}

function buildJobEnvStatus(env) {
  return `${buildStatus(getJenkinsStatus(env))}${buildStatus(env.deployStatus)}`;
}

function getJenkinsStatus(env) {
  return env.inQueueSince ? "QUEUED" : env.buildStatus;
}

function buildStatus(status) {
  return `<td class="${getStatusClass(status)} icon">${getStatusText(status)}</td>`;
}

function getJobType(name) {
  if (name.startsWith("api-")) return "api";
  else if (name.startsWith("db-")) return "database";
  else if (name.startsWith("mongo-to-")) return "service";
  else if (name.startsWith("webui-")) return "web";
  else if (name.startsWith("wnd-")) return "component";
  return "other";
}

// Jenkins: BUILDING, SUCCESS, UNSTABLE, FAILURE, NOT_BUILT, ABORTED
// AWS ECS: COMPLETED, IN_PROGRESS, FAILED

function getStatusText(status) {
  switch (status) {
    case "QUEUED":      return "Queued";
    case "BUILDING":    return "Building";
   	case "IN_PROGRESS": return "Deploying";
    case "FAILED":      return "Failed!";
    case "FAILURE":     return "Failed!";
    case "ABORTED":     return "Aborted";
    case "UNSTABLE":    return "Unstable";
    case "NOT_BUILT":   return "Not Built";
    case "COMPLETED":   return "Completed";
    case "SUCCESS":     return "Success";
  }
  return "";
}

function getStatusClass(status) {
  switch (status) {
    case "QUEUED":      return "queued";
    case "BUILDING":    return "building";
    case "IN_PROGRESS": return "deploying";
    case "FAILED":      return "failed";
    case "FAILURE":     return "failed";
    case "ABORTED":     return "unknown";
    case "UNSTABLE":    return "unknown";
    case "NOT_BUILT":   return "unknown";
    case "COMPLETED":   return "success";
    case "SUCCESS":     return "success";
  }
  return "";
}

// Lower rank wins the overall status: active or pending work first (it may fix a failure),
// then failures, then oddities, then success. Statuses we don't recognize rank last so they can't hide a real one.
function getStatusRank(status) {
  switch (getStatusClass(status)) {
    case "deploying": return 0;
    case "building":  return 1;
    case "queued":    return 2;
    case "failed":    return 3;
    case "unknown":   return 4;
    case "success":   return 5;
  }
  return 6;
}

// Missing or unrecognized statuses rank below everything, so include a known status (e.g. "SUCCESS") as the default.
function getHighestPriorityStatus(...statuses) {
  return statuses.reduce((a, b) => getStatusRank(b) < getStatusRank(a) ? b : a);
}

function getStatusIcon(status) {
  if (status) return `${getStatusClass(status)}.png`;
}

setInterval(function() {
  if (_enableRefreshAt) {
    const seconds = getDateDiffSeconds(_enableRefreshAt, new Date());
    if (seconds >= 0) {
      $("#btnRefresh").removeAttr('disabled');
      _enableRefreshAt = undefined;
    } else {
      $("#btnRefresh").attr('disabled','disabled');
    }
  }
/*  if (_enableBoostAt) {
    const seconds = getDateDiffSeconds(_enableBoostAt, new Date());
	if (seconds >= 0) {
      $("#btnBoost").removeAttr('disabled');
	  _enableBoostAt = undefined;
	}
  }*/
  if (!_checking && _lastCheckedOn) {
    let seconds = getDateDiffSeconds(_lastCheckedOn, new Date());
    $("#lastChecked").text(`${getTimespanString(seconds)} ago`);
  }
  updateStaleness();
}, 1000);

// The AWS status is stale when no check has finished in over twice the refresh rate
// (plus slack for the check itself), e.g. the poller is down or MQTT is disconnected.
function updateStaleness() {
  if (!_shouldReconnect || _newVersion !== _currentVersion) return;
  if (!_lastCheckedOn || !_refreshRate) return;
  const seconds = getDateDiffSeconds(_lastCheckedOn, new Date());
  const isStale = seconds > _refreshRate * 2 + 30;
  if (isStale === _isStale) return;
  _isStale = isStale;
  $(".statusBar").toggleClass("stale", isStale);
  renderOverallStatuses();
}

function getTimespanString(seconds) {
  // The poller's clock can be slightly ahead of the browser's, so don't show "-3 seconds ago".
  seconds = Math.max(0, seconds);
  let minutes = seconds / 60;
  seconds = seconds % 60;
  minutes = Math.floor(minutes);
  seconds = Math.floor(seconds);
  if (minutes === 0)
    return `${seconds} seconds`;
  if (seconds === 0)
    return `${minutes} minutes`;
  return `${minutes} min ${seconds} sec`;
}

function getDateDiffSeconds(startDate, endDate) {
  return (endDate.getTime() - startDate.getTime()) / 1000;
}

function timestampToDate(ts) {
  return new Date(parseInt(ts));
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function setStatus(text) {
  $('#connStatus').text(text);
  $('#status').text(text);
}

function loadNewVersionView() {  
  $("#currentVersion").text(_currentVersion);
  $("#newVersion").text(_newVersion);
  $("#ConnectionView").hide();
  $("#MainView").hide();
  $("#NewVersionView").show();  
  $('link[rel="icon"]').attr('href', "icons/refresh.png");
}

function loadMainView() {
  $("#ConnectionView").hide();
  $("#MainView").show();
  $("#btnDisconnect").show();
  $("#txtFilter").val("");
  _filter = "";
  $("#btnResetFilter").hide();
}

function loadConnectionView() {
  $("#MainView").hide();
  $("#btnDisconnect").hide();
  $("#btnCancel").hide();
  if (_mqttCreds) {
    $("#txtMQTTHostName").val(_mqttCreds.host);
    $("#txtMQTTUserName").val(_mqttCreds.username);
    $("#txtMQTTPassword").val(_mqttCreds.password);
  }
  $("#btnConnect").removeAttr("disabled");
  $("#txtMQTTHostName").removeAttr("disabled");
  $("#txtMQTTUserName").removeAttr("disabled");
  $("#txtMQTTPassword").removeAttr("disabled");
  $("#ConnectionView").show();
  $('link[rel="icon"]').attr('href', "icons/connect.png");
}


// ----------------------------------------------------------------------------
// jQuery event wire-up
$(document).ready(function() {

  $("#btnConnect").on("click", function() {
    $("#txtMQTTHostName").attr('disabled','disabled');
    $("#txtMQTTUserName").attr('disabled','disabled');
    $("#txtMQTTPassword").attr('disabled','disabled');
    $("#btnConnect").attr('disabled','disabled');
    $("#btnCancel").show();
    _mqttCreds = {
      host: $("#txtMQTTHostName").val(),
      username: $("#txtMQTTUserName").val(),
      password: $("#txtMQTTPassword").val(),
    };
    localStorage.setItem("_mqttCreds", JSON.stringify(_mqttCreds));
    _shouldReconnect = true;
    setTimeout(MQTT_Connect,100);
  });

  $("#btnCancel").on("click", function() {
    MQTT_Disconnect();
    localStorage.setItem("autoConnect", false);
    setStatus("Not connected");
    $("#btnConnect").removeAttr("disabled");
    $("#txtMQTTHostName").removeAttr("disabled");
    $("#txtMQTTUserName").removeAttr("disabled");
    $("#txtMQTTPassword").removeAttr("disabled");
    $("#btnCancel").hide();
  });

  $("#btnDisconnect").on("click", function() {
    MQTT_Disconnect();
    localStorage.setItem("autoConnect", false);
    loadConnectionView();
  });

  $("#txtFilter").on("change", function() {
    _filter = $("#txtFilter").val().toLowerCase();
    renderMainView();
    if (_filter !== "") {
      $("#btnResetFilter").show();
    } else {
      $("#btnResetFilter").hide();
    }
  });

  $("#btnResetFilter").on("click", function() {
    _filter = "";
    renderMainView();
    $("#txtFilter").val("");
    $("#btnResetFilter").hide();
  });

  $("#btnRefresh").on("click", function() {
    MQTT_Publish("AWS-WonScore/ECS/services/refresh", (new Date()).getTime().toString());
    $("#btnRefresh").attr('disabled','disabled');
    _enableRefreshAt = new Date((new Date()).getTime() + 1000);
  });

  $("#btnBoost").on("click", function() {
    MQTT_Publish("AWS-WonScore/ECS/services/refreshRate", "10", 0, true);
    $("#btnBoost").attr('disabled','disabled');
    //_enableBoostAt = new Date((new Date()).getTime() + 1000);
  });

});

$(document).ready(function() {
  _mqttCreds = localStorage.getItem("_mqttCreds");
  if (_mqttCreds) {
    _mqttCreds = JSON.parse(_mqttCreds);
  }
  loadConnectionView();
  const autoConnect = localStorage.getItem("autoConnect");
  if (autoConnect === "true") {
    $("#btnConnect").click();    
  }
});


// ----------------------------------------------------------------------------
// Documentation:
//   https://eclipse.dev/paho/index.php?page=clients/js/index.php
//   https://eclipse.dev/paho/files/jsdoc/index.html

let _mqttClient;
let _mqttSubscriptions;

function MQTT_Publish(topic, payload, qos=0, retained=false) {
  const message = new Paho.MQTT.Message(payload);
  message.destinationName = topic;
  message.qos = qos;
  message.retained = retained;
  _mqttClient.send(message);
}

function MQTT_Subscribe(topic, cb) {
  _mqttSubscriptions[topic] = cb;
  _mqttClient.subscribe(topic, {qos: 0});
}

function MQTT_Connect() {
  if (!_shouldReconnect) return;

  // Random suffix so concurrent viewers don't share an id (the broker drops the older connection on a duplicate).
  // Kept under 23 chars for brokers that enforce the MQTT 3.1 client id limit.
  const clientId = "wsdeploy_" + Math.random().toString(36).slice(2, 12);
  _mqttClient = new Paho.MQTT.Client(_mqttCreds.host, 443, clientId);
  _mqttClient.onConnectionLost = onMQTTConnectionLost;

  _mqttClient.onMessageArrived = function(message) {
    for (const topic of Object.keys(_mqttSubscriptions)) {
      _tryDeliverToSubscriber(topic, message.destinationName, message.payloadString);
    }
  }

  function _tryDeliverToSubscriber(subTopic, msgTopic, msgPayload) {
    const subParts = subTopic.split("/");
    const msgParts = msgTopic.split("/");
    const captures = [];
    for (let i=0; i<subParts.length; i++) {
      const namePart = msgParts[i];
      const topicPart = subParts[i];
      if (topicPart === "#") {
        for (; i<msgParts.length; i++) {
          captures.push(msgParts[i]);
        }
        break;
      } else if (topicPart === "+") {
        captures.push(namePart);
      } else if (namePart !== topicPart) {
        return;
      }
    }
    _mqttSubscriptions[subTopic](msgPayload, captures);
  }

  setStatus("Connecting...");
  _shouldReconnect = true;
  _mqttClient.connect({
    useSSL: true,
    userName: _mqttCreds.username,
    password: _mqttCreds.password,
    timeout: 3,
    onSuccess: function() {
      _mqttSubscriptions = {};
      onMQTTConnected();
    },
    onFailure: onMQTTConnectionFailure
  });
}

function MQTT_Disconnect() {
  _shouldReconnect = false;
  if (_mqttClient) {
    try {
      _mqttClient.disconnect();
    }
    catch (ex) {}
  }
}
