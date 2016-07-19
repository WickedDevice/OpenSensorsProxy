var Promise = require("bluebird");
var rp = require('request-promise');
var fs = require("fs");
var promiseDoWhilst = require('promise-do-whilst');

// config encapsulates opensensors-api-key
// valid keys for config are: api-key (required)
module.exports = function(config) {
    var API_POST_OPTIONS = {
        headers: {
            Accept: "application/json",
            Authorization: "api-key " + config["api-key"]
        }
    };

    var requests_filename = "./current_requests.json";
    var MAX_CONCURRENT_REQUESTS_IN_FLIGHT = 5;

    // on launch delete ther requests file
    if(fs.existsSync(requests_filename)) {
        fs.unlinkSync(requests_filename);
        console.log("Removed existing requests file: " + requests_filename);
    }

    // create it blank
    fs.writeFileSync(requests_filename, JSON.stringify([]));

    var API_BASE_URL = "https://api.opensensors.io";

    var httpGet = function(url, options){
        var options = Object.assign(
          {},
          {
            uri: url,
            resolveWithFullResponse: true,
            json: true,
            simple: false
          },
          options);

        return rp(options);
    };

    // helper (actually workhorse) method that does a GET to a URL
    // it appends the augmented payloads in the response to the second argument that gets passed to it
    // if the response body JSON contains a next element it recursively calls itself
    var retireRequest = function(theUrl){
        try {
            var file_contents = fs.readFileSync(requests_filename, 'utf8');
            if (file_contents.trim() == "") {
                file_contents = "[]";
            }
            var current_requests = JSON.parse(file_contents);

            // remove url from the list
            var i = current_requests.indexOf(theUrl);
            if (i != -1) {
                current_requests.splice(i, 1);
            }
            fs.writeFileSync(requests_filename, JSON.stringify(current_requests));
        }
        catch (e) {
            console.log(requests_filename + ' is corrupt - JSON parse failed');
            // this is also a really bad situation, but I don't know what can be done about it
        }
    };

    var getUntil200 = function(url){
        var theUrl = url;
        var requestsInFlight = 0;
        var current_requests = [];
      var requestCompletedSuccessfully = false;
      var fatalError = null;
      var gotNon200 = false;
      var gotSaturated = false;
      var theResponse = null;

      return promiseDoWhilst(() => {
        // do this promise
        return Promise.try(() => {
        try{
            var file_contents = fs.readFileSync(requests_filename, 'utf8');
            if(file_contents.trim() == ""){
                file_contents = "[]";
            }
            current_requests = JSON.parse(file_contents);
            requestsInFlight = current_requests.length;
        }
        catch(e){
            console.log(requests_filename + ' is corrupt - JSON parse failed -- deleting it');
            fs.unlinkSync(requests_filename);
            file_contents = "[]";
            current_requests = JSON.parse(file_contents);
            requestsInFlight = current_requests.length;
        }

        if(requestsInFlight < MAX_CONCURRENT_REQUESTS_IN_FLIGHT) {
            // if the server is not saturated, go ahead and make a request and increase the saturation level

            // add this request to the list of in flight requests
            // if it's not already in the list
            if(current_requests.indexOf(theUrl) == -1) {
            current_requests.push(theUrl);
            try {
                fs.writeFileSync(requests_filename, JSON.stringify(current_requests));
            }
            catch(e){
                console.log("Failed to write to " + requests_filename);
                // this is very bad... we really shouldn't proceed at this point with this request
                // it should in fact be as though we were saturated
                // just as though we had gotten a 400 response, just try again sooner
                console.log("Deferring request " + theUrl + " for 5 seconds");
                return;
            }

            return Promise.try(function () {
                return httpGet(theUrl, API_POST_OPTIONS);
            }).then(function (response) {
                if (response.statusCode !== 200) {
                    console.log(theUrl);
                    console.log(response.body);
                  console.log("Got Status Code " + response.statusCode + ", waiting 30 seconds before trying " + theUrl + " again");
                  gotNon200 = true;
                }
                else {
                    // finally! we can retire this request from the list and pass the results on
                  retireRequest(theUrl);
                  requestCompletedSuccessfully = true;
                  return response;
                        }
              }).catch(function(error){
                // kill this request status file
                retireRequest(theUrl);
                console.log("+++++++++++++++++++++++");
                console.log("Error: " + error.message + " " + error.stack);
                console.log("+++++++++++++++++++++++");
                // fatalError = error;
                gotSaturated = true; // treat it like you got a saturated result
              });
                        }
                    }
          else{
            console.log("Saturated - Deferring request " + theUrl + " for 5 seconds");
            gotSaturated = true;
                    }
        }).then((response) => {
          if(gotNon200){
            return new Promise((resolve, reject) => {
              setTimeout(() => {
                gotNon200 = false;
                gotSaturated = false;
                resolve();
              }, 30000);
            });
                }
          else if(gotSaturated){
            return new Promise((resolve, reject) => {
              setTimeout(() => {
                gotNon200 = false;
                gotSaturated = false;
                resolve();
              }, 5000);
            });
        }
        else{
            theResponse = response;
          }
            });
      }, () => {
        // until this function return false, i.e. don't continue
        return !requestCompletedSuccessfully && !fatalError;
      }).then(() => {
        if(!fatalError){
          return theResponse;
        }
        else{
          throw fatalError;
        }
      });
    };

    var recursiveGET = function(url, results, status, followNext){
        var theUrl = url;
        var theResults = results;
        var theStatus = Object.assign({}, {}, status);
        var theFollowNext = followNext;

        console.log(theStatus.serialNumber + " Current Num Results: " + theResults.length + " -> URL: " + theUrl);

        return Promise.try(function(){
            return getUntil200(theUrl);
        }).then(function(response){
            var theResponse = response;
            var augmentedPayloads = [];

            if(!theResponse || !theResponse.body){
              console.log("%%%%%%%%%%%%%%%%%%%%%%%%%");
              console.log("% Unexpected Response: ", JSON.stringify(theResponse,null,2));
              console.log("%%%%%%%%%%%%%%%%%%%%%%%%%");
            }
            else if(theResponse.body.messages){
                augmentedPayloads = theResponse.body.messages.map(function(msg){
                    // as it turns out nan is not valid JSON
                    var body;
                    try {
                        body = msg.payload.text.replace(/':nan/g, '":null');
                        body = body.replace(/nan/g, 'null');

                        // workaround for malformation of uknown origin resulting in ' where " should be
                        body = body.replace(/'/g, '"');

                        var datum = JSON.parse(body);
                        datum.timestamp = msg.date;
                        datum.topic = msg.topic;
                        return datum;
                    }
                    catch(exception){
                        console.log(exception);
                        console.log(body);
                        return {
                            timestamp: msg.date,
                            topic: msg.topic
                        };
                    }
                });
            }

            return Promise.try(function(){
                return theResults.concat(augmentedPayloads);
            }).then(function(results){
                var theseResults = results;
                // if there's a non-null status object provided
                // lets reach into the status.filename
                // and modify the entry for status.serialnumber
                if(theStatus && theStatus.filename) {
                    var content = fs.readFileSync(theStatus.filename, 'utf8');
                        if(content == ""){
                            content = "{}";
                        }

                        var json = null;

                        try {
                            json = JSON.parse(content);
                          if (!json[theStatus.serialNumber]) {
                            json[theStatus.serialNumber] = {};
                            }

                        if (theResponse.body.messages) {
                            json[theStatus.serialNumber].numResults = theseResults.length + theResponse.body.messages.length;
                            }
                            else {
                            json[theStatus.serialNumber].complete = true;
                            json[theStatus.serialNumber].error = true;
                            json[theStatus.serialNumber].errorMessage = "No messages found.";
                            }

                        if (theseResults.length > 0) {
                            json[theStatus.serialNumber].timestamp = theseResults[theseResults.length - 1].timestamp;
                            }

                        if (!theResponse.body.next) {
                            json[theStatus.serialNumber].complete = true;
                            }
                            else {
                            json[theStatus.serialNumber].complete = false;
                            }
                        }
                        catch(err){
                            console.log(err);
                            return null;
                        }

                        if(json) {
                        try {
                            fs.writeFileSync(theStatus.filename, JSON.stringify(json));
                        }
                        catch(error){
                            console.log(error.message);
                        }
                    }
                    console.log(theStatus.serialNumber + " Wrote "+ JSON.stringify(json) + " to " + theStatus.filename);
                    return theseResults;
                }
                else {
                    return theseResults; // pass it through
                }
            }).delay(1000).then(function(newResults){
                if(theFollowNext && theResponse.body.next){
                    console.log("Next Found on url " + theUrl);
                    console.log("Last timestamp: " + theResponse.body.messages[theResponse.body.messages.length - 1].date);
                    return recursiveGET(API_BASE_URL + theResponse.body.next, newResults, theStatus, theFollowNext);
                }
                else{
                    console.log(theStatus.serialNumber + " Next Not Found on url " + theUrl);
                    // console.log(response.body);
                    if(theResponse.body.messages && theResponse.body.messages.length > 0) {
                        console.log("Response contained messages field with " + theResponse.body.messages.length
                          + " messages, Last timestamp: " + theResponse.body.messages[theResponse.body.messages.length - 1].date);
                    }
                    else if(!theResponse.body.messages){
                       console.log("Response did not contain any messages field");
                    }
                    else if(theResponse.body.messages.length === 0){
                       console.log("Response contained messages field with zero messages");
                    }
                    else{
                       console.log("Unexpected response content: ");
                       console.log(theResponse.body);
                    }
                    console.log("Total Results: " + newResults.length);
                    return newResults;
                }
            });
        }).catch(function(error){
            console.log("***********************");
            console.log("Error: " + error.message + " " + error.stack);
            console.log("***********************");
            return [];
        });
    };

    // this function returns a string to append to a url path
    // to add the [flat] params object as a querystring
    function urlParams(params){
        var ret = "";
        if(Object.keys(params).length > 0){ // if there are any optional params
            ret += '?';

            var encodeParams = Object.keys(params).map(function(key){
                if(key != "status") { // special case, not an OpenSensors parameter
                    return key + '=' + encodeURIComponent(params[key]);
                }
            });

            ret += encodeParams.join('&');
        }
        return ret;
    }

    // this function returns a string to append to a url path
    // to add the [flat] params object as a querystring
    function collectMessagesBy(x, val, params){
        var API_MESSAGES_BY_PATH = "/v1/messages/" + x;
        var url = API_BASE_URL + API_MESSAGES_BY_PATH;
        if(!val){
            console.error(x + "is required");
            return Promise.resolve({});
        }

        url += "/" + val+ urlParams(params);

        var status = params ? Object.assign({}, {}, params.status) : null;

        return recursiveGET(url, [], status); // don't follow next, that is up to the caller for a proxy
    }

    // returns an array of message payloads from the API, augmented with timestamp
    // valid optional param keys are "start-date", "end-date", and "dur"
    function collectMessagesByDevice(device, params){
        return collectMessagesBy("device", device, params);
    }

    // returns an array of message payloads from the API, augmented with timestamp
    // valid optional param keys are "start-date", "end-date", and "dur"
    function collectMessagesByTopic(topic, params){
        return collectMessagesBy("topic", topic, params);
    }

    // returns an array of message payloads from the API, augmented with timestamp
    // valid optional param keys are "start-date", "end-date", and "dur"
    function collectMessagesByUser(user, params){
        return collectMessagesBy("user", user, params);
    }

    // this is what require(opensensors)(config) actually will return
    return {
        messages: {
            byDevice: collectMessagesByDevice,
            byTopic: collectMessagesByTopic,
            byUser: collectMessagesByUser
        }
    };
};