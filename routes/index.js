var expressPromiseRouter = require("express-promise-router");
var router = expressPromiseRouter();
var Promise = require("bluebird");
var config = require('../../eggdataconfig')();
var bhttp = Promise.promisifyAll(require("bhttp"));

var API_POST_OPTIONS = {
  headers: {
    Accept: "application/json",
    Authorization: "api-key " + config["api-key"]
  }
};
var API_BASE_URL = "https://api.opensensors.io";

/* GET home page. */
router.get('/', function(req, res) {
  res.render('index', { title: 'Express' });
});

function getOpenSensorsUrl(url){
  return Promise.try(function(){
    return bhttp.get(url, API_POST_OPTIONS);
  });
}

function postOpenSensorsUrl(url, data){
  return Promise.try(function(){
    return bhttp.post(url, data, API_POST_OPTIONS);
  });
}

router.get('/v1/messages/device/:client_id', function(req, res) {
  var originalUrl = API_BASE_URL + req.originalUrl;
  return Promise.try(function(){
    return getOpenSensorsUrl(originalUrl);
  }).then(function(response){
    console.log("status: " + response.statusCode + ", body:" + JSON.stringify(response.body));
    res.statusCode = response.statusCode;
    res.send(response.body);
  });
});

module.exports = router;
