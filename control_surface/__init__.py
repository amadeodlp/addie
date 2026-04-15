# Addie Control Surface — entry point
#
# Live calls create_instance() to instantiate the control surface.
# This is the only interface Live requires.

from .addie import Addie


def create_instance(c_instance):
    return Addie(c_instance)
