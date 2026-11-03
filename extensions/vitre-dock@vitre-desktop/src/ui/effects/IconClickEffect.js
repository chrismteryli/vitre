/*
* Dhruva GNOME Extension
* Copyright (C) 2026 NarkAgni
*
* This program is free software: you can redistribute it and/or modify
* it under the terms of the GNU General Public License as published by
* the Free Software Foundation, either version 3 of the License, or
* any later version.
*
* This program is distributed in the hope that it will be useful,
* but WITHOUT ANY WARRANTY; without even the implied warranty of
* MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
* GNU General Public License for more details.
*
* You should have received a copy of the GNU General Public License
* along with this program. If not, see <https://www.gnu.org/licenses/>.
*/



import { isActorAlive } from '../../core/Utils.js';
import {ease as liquidEase} from '../../liquid/liquidClock.js';     // liquid v3: every ease is a liquid.js spring (bead role; opacity: fade)


const DEFAULT_RESTORE_DURATION_MS = 200;

export function animateIconClick(actor, effectName) {
    if (!actor || !isActorAlive(actor) || effectName === 'none') return;

    actor.set_pivot_point(0.5, 0.5);
    if (actor.remove_all_transitions) actor.remove_all_transitions();

    const restore = () => {
        if (!isActorAlive(actor)) return;
        liquidEase(actor, {
            scale_x: 1.0,
            scale_y: 1.0,
            opacity: 255,
            translation_x: 0,
            translation_y: 0,
            rotation_angle_z: 0,
            rotation_angle_y: 0,
            duration: DEFAULT_RESTORE_DURATION_MS,
            onComplete: () => {
                if (isActorAlive(actor) && actor.set_style) {
                    actor.set_style('');
                }
            }
        });
    };

    switch (effectName) {
        case 'bounce':
            liquidEase(actor, {
                scale_x: 0.7,
                scale_y: 0.7,
                duration: 120,
                onComplete: () => {
                    liquidEase(actor, {
                        scale_x: 1.25,
                        scale_y: 1.25,
                        duration: 150,
                        onComplete: () => {
                            liquidEase(actor, {
                                scale_x: 0.9,
                                scale_y: 0.9,
                                duration: 120,
                                onComplete: () => {
                                    liquidEase(actor, {
                                        scale_x: 1.05,
                                        scale_y: 1.05,
                                        duration: 100,
                                        onComplete: restore
                                    });
                                }
                            });
                        }
                    });
                }
            });
            break;

        case 'jump':
            liquidEase(actor, {
                translation_y: -35,
                scale_x: 0.9,
                scale_y: 1.1,
                duration: 150,
                onComplete: () => {
                    liquidEase(actor, {
                        translation_y: 0,
                        scale_x: 1.1,
                        scale_y: 0.9,
                        duration: 120,
                        onComplete: () => {
                            liquidEase(actor, {
                                translation_y: -15,
                                scale_x: 0.95,
                                scale_y: 1.05,
                                duration: 120,
                                onComplete: () => {
                                    liquidEase(actor, {
                                        translation_y: 0,
                                        scale_x: 1.0,
                                        scale_y: 1.0,
                                        duration: 100,
                                        onComplete: restore
                                    });
                                }
                            });
                        }
                    });
                }
            });
            break;

        case 'heartbeat':
            liquidEase(actor, {
                scale_x: 1.15,
                scale_y: 1.15,
                duration: 100,
                onComplete: () => {
                    liquidEase(actor, {
                        scale_x: 1.0,
                        scale_y: 1.0,
                        duration: 100,
                        onComplete: () => {
                            liquidEase(actor, {
                                scale_x: 1.15,
                                scale_y: 1.15,
                                duration: 100,
                                onComplete: () => {
                                    liquidEase(actor, {
                                        scale_x: 1.0,
                                        scale_y: 1.0,
                                        duration: 100,
                                        onComplete: restore
                                    });
                                }
                            });
                        }
                    });
                }
            });
            break;

        case 'squish':
            liquidEase(actor, {
                scale_x: 1.5,
                scale_y: 0.4,
                translation_y: 20,
                duration: 150,
                onComplete: () => {
                    liquidEase(actor, {
                        scale_x: 0.9,
                        scale_y: 1.1,
                        translation_y: -5,
                        duration: 120,
                        onComplete: restore
                    });
                }
            });
            break;

        case 'jelly':
            liquidEase(actor, {
                scale_x: 1.25,
                scale_y: 0.75,
                duration: 100,
                onComplete: () => {
                    liquidEase(actor, {
                        scale_x: 0.75,
                        scale_y: 1.25,
                        duration: 100,
                        onComplete: () => {
                            liquidEase(actor, {
                                scale_x: 1.15,
                                scale_y: 0.85,
                                duration: 100,
                                onComplete: restore
                            });
                        }
                    });
                }
            });
            break;

        case 'spin':
            actor.rotation_angle_z = 0;
            liquidEase(actor, {
                rotation_angle_z: 360,
                scale_x: 1.15,
                scale_y: 1.15,
                duration: 450,
                onComplete: restore
            });
            break;

        case 'spin_3d':
            liquidEase(actor, {
                rotation_angle_y: 180,
                scale_x: 1.15,
                scale_y: 1.15,
                duration: 220,
                onComplete: () => {
                    liquidEase(actor, {
                        rotation_angle_y: 360,
                        scale_x: 1.0,
                        scale_y: 1.0,
                        duration: 220,
                        onComplete: restore
                    });
                }
            });
            break;

        case 'flip':
            liquidEase(actor, {
                scale_x: 0.0,
                duration: 150,
                onComplete: () => {
                    liquidEase(actor, {
                        scale_x: 1.0,
                        duration: 150,
                        onComplete: restore
                    });
                }
            });
            break;

        case 'roll':
            liquidEase(actor, {
                translation_x: 40,
                rotation_angle_z: 180,
                opacity: 150,
                duration: 180,
                onComplete: () => {
                    liquidEase(actor, {
                        translation_x: 0,
                        rotation_angle_z: 0,
                        opacity: 255,
                        duration: 180,
                        onComplete: restore
                    });
                }
            });
            break;

        case 'zoom_fade':
            liquidEase(actor, {
                scale_x: 2.0,
                scale_y: 2.0,
                opacity: 0,
                duration: 200,
                onComplete: restore
            });
            break;

        case 'squeeze':
            liquidEase(actor, {
                scale_x: 0.8,
                scale_y: 1.25,
                duration: 150,
                onComplete: () => {
                    liquidEase(actor, {
                        scale_x: 1.1,
                        scale_y: 0.9,
                        duration: 100,
                        onComplete: restore
                    });
                }
            });
            break;

        case 'glow':
            if (actor.set_style) {
                actor.set_style('box-shadow: 0px 0px 20px 5px rgba(255, 255, 255, 0.6); border-radius: 50%; background-color: rgba(255,255,255,0.1);');
            }
            liquidEase(actor, {
                scale_x: 1.15,
                scale_y: 1.15,
                duration: 200,
                onComplete: restore
            });
            break;

        case 'dim':
            liquidEase(actor, {
                opacity: 100,
                duration: 150,
                onComplete: restore
            });
            break;

        case 'tada':
            liquidEase(actor, {
                scale_x: 0.9,
                scale_y: 0.9,
                rotation_angle_z: -3,
                duration: 100,
                onComplete: () => {
                    liquidEase(actor, {
                        scale_x: 1.1,
                        scale_y: 1.1,
                        rotation_angle_z: 3,
                        duration: 100,
                        onComplete: () => {
                            liquidEase(actor, {
                                rotation_angle_z: -3,
                                duration: 100,
                                onComplete: () => {
                                    liquidEase(actor, {
                                        rotation_angle_z: 3,
                                        duration: 100,
                                        onComplete: restore
                                    });
                                }
                            });
                        }
                    });
                }
            });
            break;

        case 'swing':
            liquidEase(actor, {
                rotation_angle_z: 25,
                translation_x: 8,
                duration: 120,
                onComplete: () => {
                    liquidEase(actor, {
                        rotation_angle_z: -15,
                        translation_x: -4,
                        duration: 120,
                        onComplete: () => {
                            liquidEase(actor, {
                                rotation_angle_z: 5,
                                translation_x: 2,
                                duration: 120,
                                onComplete: () => {
                                    liquidEase(actor, {
                                        rotation_angle_z: 0,
                                        translation_x: 0,
                                        duration: 120,
                                        onComplete: restore
                                    });
                                }
                            });
                        }
                    });
                }
            });
            break;

        case 'shake':
            liquidEase(actor, {
                translation_x: 10,
                duration: 50,
                onComplete: () => {
                    liquidEase(actor, {
                        translation_x: -10,
                        duration: 50,
                        onComplete: () => {
                            liquidEase(actor, {
                                translation_x: 10,
                                duration: 50,
                                onComplete: () => {
                                    liquidEase(actor, {
                                        translation_x: -10,
                                        duration: 50,
                                        onComplete: restore
                                    });
                                }
                            });
                        }
                    });
                }
            });
            break;

        case 'move_up':
            liquidEase(actor, {
                translation_y: -20,
                duration: 150,
                onComplete: restore
            });
            break;

        case 'move_down':
            liquidEase(actor, {
                translation_y: 20,
                duration: 150,
                onComplete: restore
            });
            break;

        case 'move_left':
            liquidEase(actor, {
                translation_x: -20,
                duration: 150,
                onComplete: restore
            });
            break;

        case 'move_right':
            liquidEase(actor, {
                translation_x: 20,
                duration: 150,
                onComplete: restore
            });
            break;

        case 'enlarge':
            liquidEase(actor, {
                scale_x: 1.3,
                scale_y: 1.3,
                duration: 150,
                onComplete: restore
            });
            break;

        case 'shrink':
            liquidEase(actor, {
                scale_x: 0.7,
                scale_y: 0.7,
                duration: 150,
                onComplete: restore
            });
            break;

        default:
            liquidEase(actor, {
                scale_x: 0.8,
                scale_y: 0.8,
                duration: 100,
                onComplete: restore
            });
            break;
    }
}