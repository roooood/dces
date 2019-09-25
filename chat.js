var colyseus = require('colyseus'),
    autoBind = require('react-autobind'),
    Connection = require('./connection');

class State {
    constructor() {
        this.messages = [];
        this.onlines = 0;
    }
}
class Server extends colyseus.Room {
    constructor(options) {
        super(options);
        autoBind(this);
    }
    onInit(options) {
        this.setState(new State);
        this.clock.setTimeout(this.checkMessage, 1000);
    }

    requestJoin(options, isNewRoom) {
        return (options.create) ?
            (options.create && isNewRoom) :
            this.clients.length > 0;
    }
    async onAuth(options) {
        let ret = {
            guest: true
        };
        if (options.key != 0)
            await Connection.query('SELECT * FROM `users` LEFT JOIN `dice_users` ON `dice_users`.`uid` = `users`.`userId` LEFT JOIN `wallets` ON `users`.`token` = `wallets`.`token` where `users`.`token`=? LIMIT 1', [options.key])
                .then(results => {
                    if (results[0] != null) {
                        ret = {
                            id: results[0].userId,
                            name: results[0].username,
                        };
                        if (results[0].admin == 1) {
                            ret.admin = true;
                        }
                        else if (results[0].mute == 1) {
                            ret.mute = true;
                        }
                    }
                }, e => {
                    ret = {
                        guest: true
                    };
                });
        return ret;
    }
    onJoin(client, options, auth) {
        if ('guest' in auth) {
            client.guest = true;
            client.mute = true;

        } else {
            client.guest = false;
            for (let i in auth)
                client[i] = auth[i];
        }
        this.send(client, {
            welcome: true,

        });

        let cl;
        for (cl of this.clients) {
            if (!cl.guest && (cl.id == client.id && client.sessionId != cl.sessionId)) {
                client.close();
            }
        }
        this.state.onlines = this.state.onlines + 1;
    }
    onMessage(client, message) {
        let type = Object.keys(message)[0];
        if (client.guest == true) {
            return;
        }

        let value = message[type];
        switch (type) {
            case 'chat':
                if (!('mute' in client))
                    this.chat(client, value)
                break;
            case 'mute':
                if ('admin' in client)
                    this.muteUser(value);
                break;
            case 'delete':
                if ('admin' in client)
                    this.deleteChat(value);
                break;
        }
    }
    onLeave(client, consented) {
        this.state.onlines = this.state.onlines - 1;
    }
    onDispose() {

    }
    objectsEqual(o1, o2) {
        return Object.keys(o1).every(key => o1[key] == o2[key]);
    }
    arraysEqual(a1, a2) {
        return a1.length === a2.length && a1.every((o, idx) => this.objectsEqual(o, a2[idx]));
    }
    checkMessage() {
        let len = this.state.messages.length;
        if (len == 0)
            len = 20;
        Connection.query('SELECT `dice_message`.*,`users`.`username` FROM `dice_message`  LEFT JOIN `users`  ON `dice_message`.`uid`=`users`.`userId` WHERE `dice_message`.`type`="lobby" ORDER BY `dice_message`. `id` DESC LIMIT ' + len)
            .then(results => {
                let res, data = [];
                for (res of results) {
                    data.push({
                        id: res.id,
                        uid: res.uid,
                        sender: res.username,
                        message: res.text
                    })
                }
                if (!this.arraysEqual(data, this.state.messages)) {
                    this.state.messages = data;
                }
            });
    }
    chat(client, msg) {
        let message = {
            uid: client.id, text: msg, type: 'lobby'
        }
        Connection.query('INSERT INTO `dice_message` SET ?', message)
            .then(results => {
                Connection.query('SELECT LAST_INSERT_ID() AS `last_id` ')
                    .then(result => {
                        let id = result[0]['last_id'];
                        this.state.messages.unshift({
                            id: id,
                            uid: client.id,
                            sender: client.name,
                            message: msg
                        })
                    });
            });
    }
    deleteChat(id) {
        Connection.query('DELETE FROM `dice_message` WHERE `id` =  ?', [id]);
        this.checkMessage();
    }
    muteUser(user) {
        Connection.query('SELECT * FROM `dice_users` WHERE `uid` = ?', [user])
            .then(results => {
                if (results[0] == null) {
                    Connection.query('DELETE FROM `dice_message` WHERE `uid` = ?', [user]);
                    for (let i in this.clients) {
                        if (this.clients[i].id == user) {
                            this.clients[i].mute = true;
                        }
                    }
                    let message = {
                        uid: user, mute: 1
                    }
                    Connection.query('INSERT INTO `dice_users` SET ?', message);
                    this.checkMessage();
                }
            });

    }
}



module.exports = Server;