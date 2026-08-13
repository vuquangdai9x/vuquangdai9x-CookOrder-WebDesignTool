var config = {
    "general-rule":{
        "map-schema": [
            {
                "name": "map",
                "type": "string",
                "description": "The map schema defines the structure of the map, including the nodes and their relationships.",
            },
            {
                "name": "groups",
                "type": "array",
                "description": "The groups schema defines the structure of the groups, including the nodes and their relationships. Can work as a component of a node, and can be used to define the structure of a node.",
            },
            {
                "name": "nodes",
                "type": "array",
                "description": "The nodes schema defines the structure of the nodes, including the nodes and their relationships.",
            },
            {
                "name": "pickupable",
                "type": "array",
                "description": "The pickupable schema defines the structure of the pickupable nodes.",
            },
            {
                "name": "orderable",
                "type": "array",
                "description": "The orderable schema defines the structure of the orderable nodes.",
            }
        ],
        "group-type": [
            {
                "name": "SINGLE",
                "description": "A node that is a single item, choose from a list of nodes.",
                "data-schema": [
                    {
                        "name": "options",
                        "type": "array",
                        "description": "The list of nodes that can be chosen from."
                    }
                ],
            },
            {
                "name": "MULTIPLE",
                "description": "A node that is a combination of multiple nodes, choose from a list of nodes. Each may have quantity limits, and the group may have a maximum quantity limit.",
                "data-schema": [
                    {
                        "name": "options",
                        "type": "array",
                        "description": "The list of nodes that can be chosen from, each with a maximum quantity limit.",
                        "element-schema": [
                            {
                                "name": "name",
                                "type": "string",
                                "description": "The name of the node."
                            },
                            {
                                "name": "max-quantity",
                                "type": "number",
                                "description": "The maximum quantity of the node that can be chosen. If -1, there is no limit."
                            }
                        ]
                    },
                    {
                        "name": "max-quantity",
                        "type": "number",
                        "description": "The maximum quantity of the group that can be chosen. If -1, there is no limit."
                    }
                ],
            },
        ],
        "node-type": [
            {
                "name": "default",
                "description": "A node that is a single item, with no additional properties."
            },
            {
                "name": "BASE-TOPPING",
                "description": "A node that is made up of a base and a topping. The base is a single node, while the topping is a group of nodes. Topping is optional, and if not provided, the node will be treated as a single node.",
                "data-schema": [
                    {
                        "name": "base",
                        "type": "string",
                        "description": "The base node, which is a single node."
                    },
                    {
                        "name": "topping",
                        "type": "string",
                        "description": "The topping node, which is a group of nodes. This is optional, and if not provided, the node will be treated as a single node."
                    }
                ],
            },
            {
                "name": "TOOL",
                "description": "A node that is a tool, which can be used to process other nodes. The tool has a list of input nodes and output nodes, and the amount of input nodes required to produce the output nodes.",
                "data-schema": [
                    {
                        "name": "in-out",
                        "type": "array",
                        "description": "The list of input and output nodes, and the amount of input nodes required to produce the output nodes.",
                        "duration": "The default duration of the tool, in seconds.",
                        "element-schema": [
                            {
                                "name": "input",
                                "type": "array",
                                "description": "The list of input nodes required to produce the output nodes."
                            },
                            {
                                "name": "duration",
                                "type": "number",
                                "description": "The override duration of the tool for this specific input-output pair, in seconds. If not provided, the default duration of the tool will be used."
                            },
                            {
                                "name": "output",
                                "type": "string",
                                "description": "The output node produced by the tool."

                            },
                            {
                                "name": "amount",
                                "type": "number",
                                "description": "The amount of output nodes produced by the tool for each set of input nodes."
                            }
                        ]
                    }
                ],
            }
        ]
    },

    "map-rule":[
        {
            "name": "burger",
            // groups work as components of a node
            "groups":[
                {
                    "name":"single-bun",
                    "type":"SINGLE",
                    "options": [
                        "bun",
                        "bun-black",
                    ]
                },
                {
                    "name":"burger-topping",
                    "type":"MULTIPLE",
                    "options": [
                        {
                            "name":"patty-cooked",
                            "max-quantity": -1
                        },
                        {
                            "name":"tomato-sliced",
                            "max-quantity": -1
                        },
                        {
                            "name":"lettuce-sliced",
                            "max-quantity": -1
                        },
                        {
                            "name":"onion-sliced",
                            "max-quantity": -1
                        },
                        {
                            "name":"cheese-sliced",
                            "max-quantity": -1
                        },
                        {
                            "name":"egg-cooked",
                            "max-quantity": -1
                        }
                    ],
                    "max-quantity": -1
                },
                {
                    "name":"fries",
                    "type":"SINGLE",
                    "options": [
                        "chicken-breast-fried",
                        "chicken-wing-fried",
                        "chicken-thigh-fried",
                        "chicken-nugget-fried",
                        "potato-fried"
                    ],
                },
                {
                    "name":"fries-topping",
                    "type":"SINGLE",
                    "options": [
                        "chili-bowl",
                        "chive-sliced",
                        "cheese-sauce"
                    ]
                },
            ],
            "nodes":[
                //  Final Products
                {
                    "name":"burger-with-topping",
                    "type":"BASE-TOPPING",
                    "base":"single-bun",
                    "topping":"burger-topping"
                },

                {
                    "name":"cup-with-ice",
                    "type":"BASE-TOPPING",
                    "base":"soda-cup",
                    "topping":"ice"
                },

                {
                    "name":"fries-with-topping",
                    "type":"BASE-TOPPING",
                    "base":"fries",
                    "topping":"fries-topping"
                },

                // mid processing nodes
               
                // Pickupable Ingredients
                {
                    "name":"bun"
                },

                {
                    "name":"patty"
                },

                {
                    "name":"tomato"
                },

                {
                    "name":"lettuce"
                },

                {
                    "name":"onion"
                },

                {
                    "name":"cheese"
                },

                {
                    "name":"egg"
                },

                {
                    "name":"cup"
                },

                {
                    "name":"ice"
                },
                
                {
                    "name":"chicken-breast"
                },

                {
                    "name":"chicken-wing"
                },

                {
                    "name":"chicken-thigh"
                },

                {
                    "name":"chicken-nugget"
                },

                {
                    "name":"potato"
                },

                {
                    "name":"chili-bowl"
                },

                {
                    "name":"chive"
                },

                {
                    "name":"cheese-sauce"
                },

                // tools
                {
                    "name":"griddle",
                    "description":"A tool that can cook ingredients. It takes in raw patty and egg, and outputs cooked patty and cooked egg.",
                    "duration": 5,
                    "in-out":[
                        {
                            "input":["patty"],
                            "output":"patty-cooked",
                            "amount":1
                        },
                        {
                            "input":["egg"],
                            "output":"egg-cooked",
                            "amount":1
                        },
                    ]
                },
                {
                    "name":"fryer",
                    "description":"A tool that can fry ingredients. It takes in flour-coated chicken and sliced potatoes, and outputs fried chicken and fried potatoes.",
                    "duration": 5,
                    "in-out":[
                        {
                            "input":["chicken-breast-flour-coated"],
                            "output":"chicken-breast-fried",
                            "amount":1
                        },
                        {
                            "input":["chicken-wing-flour-coated"],
                            "output":"chicken-wing-fried",
                            "amount":1
                        },
                        {
                            "input":["chicken-thigh-flour-coated"],
                            "output":"chicken-thigh-fried",
                            "amount":1
                        },
                        {
                            "input":["chicken-nugget-flour-coated"],
                            "output":"chicken-nugget-fried",
                            "amount":1
                        },
                        {
                            "input":["potato-sliced"],
                            "output":"potato-fried",
                            "amount":1
                        }
                    ]
                },
                {
                    "name":"slicing-board",
                    "description":"A tool that can slice ingredients. It takes in whole ingredients and outputs sliced ingredients.",
                    "duration": 3,
                    "in-out":[
                        {
                            "input":["bun"],
                            "output":"bun-sliced",
                            "amount":1
                        },
                        {
                            "input":["tomato"],
                            "output":"tomato-sliced",
                            "amount":2
                        },
                        {
                            "input":["lettuce"],
                            "output":"lettuce-sliced",
                            "amount":2
                        },
                        {
                            "input":["onion"],
                            "output":"onion-sliced",
                            "amount":2
                        },
                        {
                            "input":["cheese"],
                            "output":"cheese-sliced",
                            "amount":2
                        },
                        {
                            "input":["potato"],
                            "duration": 3,
                            "output":"potato-sliced",
                            "amount":2
                        },
                        {
                            "input":["chive"],
                            "output":"chive-sliced",
                            "amount":2
                        }
                    ]
                },
                {
                    "name":"flour-coating-station",
                    "description":"A tool that can coat ingredients with flour. It takes in raw chicken and outputs flour-coated chicken.",
                    "duration": 3,
                    "in-out":[
                        {
                            "input":["chicken-breast"],
                            "output":"chicken-breast-flour-coated",
                            "amount":1
                        },
                        {
                            "input":["chicken-wing"],
                            "output":"chicken-wing-flour-coated",
                            "amount":1
                        },
                        {
                            "input":["chicken-thigh"],
                            "output":"chicken-thigh-flour-coated",
                            "amount":1
                        },
                        {
                            "input":["chicken-nugget"],
                            "output":"chicken-nugget-flour-coated",
                            "amount":1
                        }
                    ]
                },
                {
                    "name":"soda-machine",
                    "description":"A tool that can fill soda cups with soda. It takes in empty soda cups and outputs filled soda cups.",
                    "duration": 5,
                    "in-out":[
                        {
                            "input":["cup"],
                            "output":"soda-cup",
                            "amount":1
                        }
                    ]
                },

                // processed ingredients
                {
                    "name":"bun-sliced",
                },
                {
                    "name":"patty-cooked",
                },
                {
                    "name":"tomato-sliced",
                },
                {
                    "name":"lettuce-sliced",
                },
                {
                    "name":"onion-sliced",
                },
                {
                    "name":"cheese-sliced",
                },
                {
                    "name":"egg-cooked",
                },
                {
                    "name":"soda-cup",
                },
                {
                    "name":"chicken-breast-flour-coated",
                },
                {
                    "name":"chicken-breast-fried",
                },
                {
                    "name":"chicken-wing-flour-coated",
                },
                {
                    "name":"chicken-wing-fried",
                },
                {
                    "name":"chicken-thigh-flour-coated",
                },
                {
                    "name":"chicken-thigh-fried",
                },
                {
                    "name":"chicken-nugget-flour-coated",
                },
                {
                    "name":"chicken-nugget-fried",
                },
                {
                    "name":"potato-sliced",
                },
                {
                    "name":"potato-fried",
                },
            ],

            "pickupable":[
                "bun",
                "patty",
                "tomato",
                "lettuce",
                "onion",
                "cheese",
                "egg",
                "cup",
                "ice",
                "chicken-breast",
                "chicken-wing",
                "chicken-thigh",
                "chicken-nugget",
                "potato",
                "chili-bowl",
                "chive",
                "cheese-sauce"
            ],

            "orderable":[
                {
                    "node": "burger-with-topping",
                    "dirty-object": "dirty-plate",
                },
                {
                    "node": "cup-with-ice",
                    "dirty-object": "dirty-cup",
                },
                {
                    "node": "fries-with-topping",
                    "dirty-object": "dirty-paper-box",
                },
            ],

            // This is a lookup table that allows us to find the base and topping nodes for a given final product node, for node that not indicate the input
            "backward-look-up":[
                {
                    "key": "patty-cooked",
                    "value": "griddle"
                },
                {
                    "key": "egg-cooked",
                    "value": "griddle"
                },
                {
                    "key": "chicken-breast-fried",
                    "value": "fryer"
                },
                {
                    "key": "chicken-wing-fried",
                    "value": "fryer"
                },
                {
                    "key": "chicken-thigh-fried",
                    "value": "fryer"
                },  
                {
                    "key": "chicken-nugget-fried",
                    "value": "fryer"
                },
                {
                    "key": "potato-fried",
                    "value": "fryer"
                },
                {
                    "key": "bun-sliced",
                    "value": "slicing-board"
                },
                {
                    "key": "tomato-sliced",
                    "value": "slicing-board"
                },
                {
                    "key": "lettuce-sliced",
                    "value": "slicing-board"
                },
                {
                    "key": "onion-sliced",
                    "value": "slicing-board"
                },
                {
                    "key": "cheese-sliced",
                    "value": "slicing-board"
                },
                {
                    "key": "potato-sliced",
                    "value": "slicing-board"
                },
                {
                    "key": "chive-sliced",
                    "value": "slicing-board"
                },
                {
                    "key": "chicken-breast-flour-coated",
                    "value": "flour-coating-station"
                },
                {
                    "key": "chicken-wing-flour-coated",
                    "value": "flour-coating-station"
                },
                {
                    "key": "chicken-thigh-flour-coated",
                    "value": "flour-coating-station"
                },
                {
                    "key": "chicken-nugget-flour-coated",
                    "value": "flour-coating-station"
                },
                {
                    "key": "soda-cup",
                    "value": "soda-machine"
                }
            ]
        },
        // =============================================================
        {
            "name": "donut",
            "groups":[
            ],
            "nodes":[
            ],
            "pickupable":[
            ],
            "orderable":[
            ],
            "backward-look-up":[
            ]
        }
    ]
};