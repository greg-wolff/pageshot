const { Cc, Ci, Cu } = require('chrome');
const ss = require("sdk/simple-storage");
const { uuid } = require('sdk/util/uuid');
const { Request } = require("sdk/request");
const { watchFunction, watchPromise } = require("./errors");
const { URL } = require('sdk/url');
const { FxAccountsOAuthClient } = Cu.import("resource://gre/modules/FxAccountsOAuthClient.jsm", {});
const { FxAccountsProfileClient } = Cu.import("resource://gre/modules/FxAccountsProfileClient.jsm", {});

exports.initialize = function (backend) {
  if (! (ss.storage.userInfo && ss.storage.userInfo.userId && ss.storage.userInfo.secret)) {
    let info = {
      userId: "anon" + makeUuid() + "",
      secret: makeUuid()+""
    };
    console.info("Generating new device authentication ID", info.userId);
    watchPromise(saveLogin(backend, info).then(function () {
      ss.storage.userInfo = info;
      console.info("Successfully saved ID");
    }));
  } else {
    let info = ss.storage.userInfo;
    let loginUrl = backend + "/api/login";
    Request({
      url: loginUrl,
      contentType: "application/x-www-form-urlencoded",
      content: {userId: info.userId, secret: info.secret},
      onComplete: watchFunction(function (response) {
        if (response.status == 404) {
          // Need to save login anyway...
          console.log("Login failed with 404, trying to register");
          watchPromise(saveLogin(backend, info));
          return;
        } else if (response.status >= 300) {
          throw new Error("Could not log in: " + response.status);
        }
        console.log("logged in with cookie:", !!response.headers["Set-Cookie"]);
        // The only other thing we do is preload the cookies
      })
    }).post();
  }
};

function saveLogin(backend, info) {
  let registerUrl = backend + "/api/register";
  return new Promise(function (resolve, reject) {
    Request({
      url: registerUrl,
      contentType: "application/x-www-form-urlencoded",
      content: info,
      onComplete: function (response) {
        if (response.status == 200) {
          console.log("Registered login with cookie:", !!response.headers["Set-Cookie"]);
          resolve();
        } else {
          reject(new Error("Bad response: " + response.status));
        }
      }
    }).post();
  });
}

function makeUuid() {
  let s = uuid() + "";
  return s.replace(/\{/g, "").replace(/\}/g, "");
}

exports.getUserInfo = function () {
  return ss.storage.userInfo;
};

exports.setProfileInfo = function (profile) {
  ss.storage.profileInfo = profile;
};

exports.getProfileInfo = function () {
  return ss.storage.profileInfo;
};

exports.updateLogin = function (backend, info) {
  let updateUrl = backend + "/api/update";
  return new Promise((resolve, reject) => {
    Request({
      url: updateUrl,
      contentType: "application/x-www-form-urlencoded",
      content: info,
      onComplete: function (response) {
        if (response.status >= 200 && response.status < 300) {
          resolve();
        } else {
          reject(response.json);
        }
      }
    }).post();
  });
};

exports.OAuthHandler = class OAuthHandler {
  constructor(backend) {
    this.backend = backend;
    this.oAuthParams = null;
    this.withProfile = new Promise((resolve, reject) => {
      this.profileDeferred = { resolve, reject };
    });
  }

  getProfileInfo() {
    return this.withProfile.then(client => {
      return client.fetchProfile();
    });
  }

  getOAuthParams() {
    if (this.oAuthParams) {
      return Promise.resolve(this.oAuthParams);
    }
    return new Promise((resolve, reject) => {
      let url = new URL("/api/fxa-oauth/params", this.backend);
      Request({
        url,
        onComplete: response => {
          let { json } = response;
          if (response.status >= 200 && response.status < 300) {
            this.oAuthParams = json;
            resolve(json);
            return;
          }
          let err = new Error("Error fetching OAuth params");
          err.status = response.status;
          err.json = json;
          reject(err);
        }
      }).get();
    });
  }

  tradeCode(tokenData) {
    return new Promise((resolve, reject) => {
      let url = new URL("/api/fxa-oauth/token", this.backend);
      Request({
        url,
        content: tokenData,
        onComplete: response => {
          let { json } = response;
          if (response.status >= 200 && response.status < 300) {
            resolve(json);
            return;
          }
          let err = new Error("Error trading OAuth code");
          err.status = response.status;
          err.json = json;
          reject(err);
        }
      }).post();
    })
  }

  logInWithParams(parameters) {
    return new Promise((resolve, reject) => {
      let client = new FxAccountsOAuthClient({ parameters });
      client.onComplete = resolve;
      client.onError = reject;
      client.launchWebFlow();
    }).then(tokenData => {
      return this.tradeCode(tokenData);
    }).then(response => {
      this.profileDeferred.resolve(new FxAccountsProfileClient({
        serverURL: parameters.profile_uri,
        token: response.access_token
      }));
      return response;
    });
  }

  logIn() {
    return this.getOAuthParams().then(params => {
      return this.logInWithParams(params);
    });
  }
};
