/*
 * common.js: Common utility functions for requesting against Loggly APIs
 *
 * (C) 2010 Charlie Robbins
 * MIT LICENSE
 *
 */

//
// Variables for Bulk
//
var arrSize = 100,
    arrMsg = [],
    timerFunction = null;

// 
// Variables for buffer array 
// 
var arrBufferedMsg = [],
    timerFunctionForBufferedLogs = null;

// 
// flag variable to validate authToken 
//
var isValidToken = true;

//
// Variables for server retry
//
var arrRetryLogs = [],
  maxRetryAllowed = 5,
  totalRetries = 0,
  statusCode,
  notfailedOnServerError = true;

var https = require('https'),
    util = require('util'),
    request = require('request'),
    loggly = require('../loggly');

var common = exports;

//
// Failure HTTP Response codes based
// off Loggly specification.
//
var failCodes = common.failCodes = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict / Duplicate',
  410: 'Gone',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  503: 'Throttled',
  504: 'Gateway Timeout'
};

//
// Success HTTP Response codes based
// off Loggly specification.
//
var successCodes = common.successCodes = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  203: 'Non-authoritative information',
  204: 'Deleted'
};

//
// Core method that actually sends requests to Loggly.
// This method is designed to be flexible w.r.t. arguments
// and continuation passing given the wide range of different
// requests required to fully implement the Loggly API.
//
// Continuations:
//   1. 'callback': The callback passed into every node-loggly method
//   2. 'success':  A callback that will only be called on successful requests.
//                  This is used throughout node-loggly to conditionally
//                  do post-request processing such as JSON parsing.
//
// Possible Arguments (1 & 2 are equivalent):
//   1. common.loggly('some-fully-qualified-url', auth, callback, success)
//   2. common.loggly('GET', 'some-fully-qualified-url', auth, callback, success)
//   3. common.loggly('DELETE', 'some-fully-qualified-url', auth, callback, success)
//   4. common.loggly({ method: 'POST', uri: 'some-url', body: { some: 'body'} }, callback, success)
//
common.loggly = function () {
  var args = Array.prototype.slice.call(arguments),
      success = args.pop(),
      callback = args.pop(),
      responded,
      requestBody,
      headers,
      method,
      auth,
      proxy,
      isBulk,
      uri,
      bufferOptions;

  //
  // Now that we've popped off the two callbacks
  // We can make decisions about other arguments
  //
  if (args.length === 1) {
    if (typeof args[0] === 'string') {
      //
      // If we got a string assume that it's the URI
      //
      method = 'GET';
      uri    = args[0];
    }
    else {
      method      = args[0].method || 'GET';
      uri         = args[0].uri;
      requestBody = args[0].body;
      auth        = args[0].auth;
      isBulk      = args[0].isBulk;
      headers     = args[0].headers;
      proxy       = args[0].proxy;
      bufferOptions = args[0].bufferOptions;
    }
  }
  else if (args.length === 2) {
    method = 'GET';
    uri    = args[0];
    auth   = args[1];
  }
  else {
    method = args[0];
    uri    = args[1];
    auth   = args[2];
  }

  function onError(err) {
    if(!isValidToken){
      console.log(err);
      return;
    }
    var arrayLogs = [];
    if(isBulk) {
      arrayLogs = requestOptions.body.split('\n');
    } else {
      arrayLogs.push(requestOptions.body);
    }
    storeLogs(arrayLogs);

    if (!responded) {
      responded = true;
      if (callback) { callback(err) }
    }
  }
  var requestOptions = {
    uri: isBulk ? uri + '/tag/' + headers['X-LOGGLY-TAG'] : uri,
    method: method,
    headers: isBulk ? {} : headers || {},             // Set headers empty for bulk
    proxy: proxy
  };

  var requestOptionsForBufferedLogs = JSON.parse(JSON.stringify(requestOptions))

  if (auth) {
    requestOptions.headers.authorization = 'Basic ' + new Buffer(auth.username + ':' + auth.password).toString('base64');
  }
  if (requestBody) {
    requestOptions.body = requestBody;
    arrRetryLogs = arrRetryLogs.concat(requestBody);
  }
  function sendLogs() {
    if (arrRetryLogs.length && !requestBody) {
      requestOptions.body = arrRetryLogs[0];
    }
    try {
      request(requestOptions, function (err, res, body) {
        if (err) return onError(err);

        statusCode = res.statusCode.toString();
        if(statusCode === '403') isValidToken = false;
        if (statusCode === '200') {
          arrRetryLogs.splice(0, 1);
          totalRetries = 0;
        }
        if (statusCode === '500' || statusCode === '503' || statusCode === '504') retryOnServerError(res);
        if (Object.keys(failCodes).indexOf(statusCode) !== -1) {
          if (statusCode !== '503' && statusCode !== '500' && statusCode !== '504') {
          return onError((new Error('Loggly Error (' + statusCode + '): ' + failCodes[statusCode])));
          }
        }
        success(res, body);
      });
    }
    catch (ex) {
      onError(ex);
    }
  }
  function sendBulkLogs() {
    if (arrRetryLogs.length && !arrMsg.length) {
      requestOptions.body = arrRetryLogs.join('\n');
    }
    //
    // Join Array Message with new line ('\n') character
    //
    if (arrMsg.length) requestOptions.body = arrMsg.join('\n');
    arrMsg.length = 0;
    try {
      request(requestOptions, function (err, res, body) {
        if (err) return onError(err);

        statusCode = res.statusCode.toString();
        if(statusCode === '403') isValidToken = false;
        if (statusCode === '200') {
          arrRetryLogs.splice(0, arrSize);
          totalRetries = 0;
        }
        if (statusCode === '500' || statusCode === '503' || statusCode === '504') retryOnServerError(res);
        if (Object.keys(failCodes).indexOf(statusCode) !== -1) {
          if (statusCode !== '503' && statusCode !== '500' && statusCode !== '504') {
          return onError((new Error('Loggly Error (' + statusCode + '): ' + failCodes[statusCode])));
          }
        }
        success(res, body);
      });
    }
    catch (ex) {
      onError(ex);
    }
  }
  if (isBulk && isValidToken) {
    if (timerFunction === null) {
      timerFunction = setInterval(function () {
        sendBulkLogs();
        if (timerFunction && !arrMsg.length) {
          clearInterval(timerFunction)
          timerFunction = null;
        }
      },5000);
    }

    if (Array.isArray(requestBody)) {
      arrMsg.push.apply(arrMsg, requestBody);
    } else {
      arrMsg.push(requestBody);
    }

    if (arrMsg.length === arrSize) {
      sendBulkLogs();
    }
  }
  else if(isValidToken) {
    sendLogs();
  }

  function retryOnServerError(err) {
    if (!arrRetryLogs) return;
    if (notfailedOnServerError && totalRetries >= maxRetryAllowed) {
      console.log('Failed after ' + totalRetries + ' retries on error - ' + statusCode, err.statusMessage);
      notfailedOnServerError = false;
      arrRetryLogs.length = 0;
    }
    while (isValidToken && totalRetries < maxRetryAllowed) {
      console.log('Failed on error code ' + statusCode);
      console.log('Retried ' + (totalRetries + 1) + ' time');
      totalRetries++;
      isBulk ? sendBulkLogs() : sendLogs();
    }
  }

  //
  // retries to send buffered logs to loggly in every 30 seconds
  //
  if (timerFunctionForBufferedLogs === null && bufferOptions) {
    timerFunctionForBufferedLogs = setInterval(function () {
      if (arrBufferedMsg.length) sendBufferdLogstoLoggly();
        if (timerFunctionForBufferedLogs && !arrBufferedMsg.length) {
          clearInterval(timerFunctionForBufferedLogs);
          timerFunctionForBufferedLogs = null;
        }
    }, bufferOptions.retriesInMilliSeconds);
  }


  function sendBufferdLogstoLoggly() {
    if (!arrBufferedMsg.length) return;
    var arrayMessage = [];
    var bulkModeBunch = arrSize;
    var inputModeBunch = 1;
    var logsInBunch = isBulk ? bulkModeBunch : inputModeBunch;
    arrayMessage = arrBufferedMsg.slice(0, logsInBunch);
    requestOptionsForBufferedLogs.body = isBulk ? arrayMessage.join('\n') : arrayMessage[0];
    request(requestOptionsForBufferedLogs, function (err, res, body) {
      if(err) return;
      var statusCode = res.statusCode.toString();
      if(statusCode === "200") {
        arrBufferedMsg.splice(0, logsInBunch);
        sendBufferdLogstoLoggly();
      }
    });
    requestOptionsForBufferedLogs.body = '';
  }

//
// This function will store logs into buffer
//
  function storeLogs(logs) {
    if (!logs.length || !bufferOptions) return;
    var numberOfLogsToBeRemoved = (arrBufferedMsg.length + logs.length) - bufferOptions.size;
    if (numberOfLogsToBeRemoved > 0) arrBufferedMsg = arrBufferedMsg.splice(numberOfLogsToBeRemoved);
      arrBufferedMsg = arrBufferedMsg.concat(logs);
    }
};
//
// ### function serialize (obj, key)
// #### @obj {Object|literal} Object to serialize
// #### @key {string} **Optional** Optional key represented by obj in a larger object
// Performs simple comma-separated, `key=value` serialization for Loggly when
// logging for non-JSON values.
//
common.serialize = function (obj, key) {
  if (obj === null) {
    obj = 'null';
  }
  else if (obj === undefined) {
    obj = 'undefined';
  }
  else if (obj === false) {
    obj = 'false';
  }

  if (typeof obj !== 'object') {
    return key ? key + '=' + obj : obj;
  }

  var msg = '',
      keys = Object.keys(obj),
      length = keys.length;

  for (var i = 0; i < length; i++) {
    if (Array.isArray(obj[keys[i]])) {
      msg += keys[i] + '=[';

      for (var j = 0, l = obj[keys[i]].length; j < l; j++) {
        msg += common.serialize(obj[keys[i]][j]);
        if (j < l - 1) {
          msg += ', ';
        }
      }

      msg += ']';
    }
    else {
      msg += common.serialize(obj[keys[i]], keys[i]);
    }

    if (i < length - 1) {
      msg += ', ';
    }
  }

  return msg;
};

//
// function clone (obj)
//   Helper method for deep cloning pure JSON objects
//   i.e. JSON objects that are either literals or objects (no Arrays, etc)
//
common.clone = function (obj) {
  var clone = {};
  for (var i in obj) {
    clone[i] = obj[i] instanceof Object ? common.clone(obj[i]) : obj[i];
  }

  return clone;
};
